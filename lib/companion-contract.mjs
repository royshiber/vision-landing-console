/**
 * Console consumption of Companion API v1.
 * Source of truth: Jetson architecture/openapi/companion-api-v1.yaml
 * Local file: vendor/jetson-companion-api/openapi/companion-api-v1.yaml (snapshot).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { CompanionApiError } from "./companion-api-error.mjs";

const SPEC_REL = path.join(
  "..",
  "vendor",
  "jetson-companion-api",
  "openapi",
  "companion-api-v1.yaml",
);

/** Console-only states — not in the aircraft wire enum. */
export const CONSOLE_LOCAL_STATES = Object.freeze(["DISABLED", "NOT_PRESENT"]);

/** Transitional camelCase / legacy names. New code must use contract names. */
export const CONTRACT_FIELD_ALIASES = Object.freeze({
  cpu_temp_c: ["cpuTempC"],
  gpu_temp_c: ["gpuTempC"],
  mem_used_pct: ["memUsedPct"],
  voltage_v: ["voltageV", "voltage"],
  latency_ms: ["latencyMs"],
  pad_visible: ["padVisible"],
  heartbeat_hz: ["heartbeatHz"],
  quality: ["slamQuality"],
  version: ["appVersion"],
  connected: ["reachable"],
});

let _spec = null;

export function companionContractPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, SPEC_REL);
}

export function loadCompanionOpenApi() {
  if (_spec) return _spec;
  const raw = readFileSync(companionContractPath(), "utf8");
  _spec = parseYaml(raw);
  if (!_spec || _spec.openapi !== "3.1.0" || !_spec.paths) {
    throw new Error("Companion OpenAPI snapshot is missing or not OpenAPI 3.1");
  }
  return _spec;
}

/** Test hook — do not use in production. */
export function _resetCompanionOpenApiCache() {
  _spec = null;
}

export function listContractGetPaths() {
  const spec = loadCompanionOpenApi();
  return Object.entries(spec.paths)
    .filter(([, ops]) => ops && ops.get)
    .map(([p]) => p);
}

export function listContractWriteMethods() {
  const spec = loadCompanionOpenApi();
  const out = { PATCH: [], PUT: [] };
  for (const [p, ops] of Object.entries(spec.paths)) {
    if (ops?.patch) out.PATCH.push(p);
    if (ops?.put) out.PUT.push(p);
  }
  return out;
}

function resolveRef(spec, node) {
  if (!node || typeof node !== "object") return node;
  if (!node.$ref) {
    if (node.allOf) {
      const merged = { type: "object", properties: {}, required: [], additionalProperties: true };
      for (const part of node.allOf) {
        const r = resolveRef(spec, part);
        Object.assign(merged.properties, r.properties || {});
        if (Array.isArray(r.required)) merged.required.push(...r.required);
        if (r.additionalProperties === false) merged.additionalProperties = false;
      }
      return merged;
    }
    return node;
  }
  const ref = String(node.$ref);
  const m = ref.match(/^#\/components\/schemas\/([^/]+)$/);
  if (!m) throw new Error(`Unsupported $ref: ${ref}`);
  const schema = spec.components?.schemas?.[m[1]];
  if (!schema) throw new Error(`Missing schema ${m[1]}`);
  return resolveRef(spec, schema);
}

function collectAliases(schemaNode) {
  const out = {};
  const walk = (node, prefix) => {
    const resolved = node && node.$ref ? node : node;
    if (!resolved || typeof resolved !== "object") return;
    const props = resolved.properties;
    if (!props) return;
    for (const [key, val] of Object.entries(props)) {
      const pathKey = prefix ? `${prefix}.${key}` : key;
      const aliases = val?.["x-console-aliases"];
      if (Array.isArray(aliases) && aliases.length) out[pathKey] = aliases;
      if (val && typeof val === "object") walk(val, pathKey);
    }
  };
  walk(schemaNode, "");
  return out;
}

export function getResponseSchema(method, apiPath) {
  const spec = loadCompanionOpenApi();
  const op = spec.paths?.[apiPath]?.[String(method).toLowerCase()];
  if (!op) return null;
  const body = op.responses?.["200"]?.content?.["application/json"];
  if (!body?.schema) return null;
  return resolveRef(spec, body.schema);
}

export function getContractExample(apiPath, exampleName) {
  const spec = loadCompanionOpenApi();
  const body = spec.paths?.[apiPath]?.get?.responses?.["200"]?.content?.["application/json"]
    || spec.paths?.[apiPath]?.patch?.responses?.["200"]?.content?.["application/json"]
    || spec.paths?.[apiPath]?.put?.responses?.["200"]?.content?.["application/json"];
  if (!body) return null;
  if (exampleName && body.examples?.[exampleName]?.value) return structuredClone(body.examples[exampleName].value);
  if (body.example) return structuredClone(body.example);
  const first = body.examples && Object.values(body.examples)[0];
  return first?.value ? structuredClone(first.value) : null;
}

function typeOk(value, typeSpec) {
  const types = Array.isArray(typeSpec) ? typeSpec : [typeSpec];
  return types.some((t) => {
    if (t === "null") return value === null;
    if (t === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (t === "array") return Array.isArray(value);
    if (t === "integer") return typeof value === "number" && Number.isInteger(value);
    if (t === "number") return typeof value === "number" && Number.isFinite(value);
    if (t === "string") return typeof value === "string";
    if (t === "boolean") return value === true || value === false;
    return true;
  });
}

function validateAgainst(spec, schema, value, loc) {
  const resolved = resolveRef(spec, schema);
  if (value === undefined) return;
  const types = resolved.type;
  if (types && !typeOk(value, types)) {
    throw new CompanionApiError("schema", `Invalid type at ${loc}`, { path: loc, expected: types });
  }
  if (resolved.enum && value != null && !resolved.enum.includes(value)) {
    throw new CompanionApiError("schema", `Invalid enum at ${loc}`, { path: loc, expected: resolved.enum });
  }
  if (resolved.type === "object" || (Array.isArray(resolved.type) && resolved.type.includes("object"))) {
    if (value === null) return;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new CompanionApiError("schema", `Expected object at ${loc}`, { path: loc });
    }
    for (const req of resolved.required || []) {
      if (value[req] === undefined) {
        throw new CompanionApiError("schema", `Missing required field ${loc}.${req}`, { path: `${loc}.${req}` });
      }
    }
    const props = resolved.properties || {};
    for (const [k, sub] of Object.entries(props)) {
      if (value[k] !== undefined) validateAgainst(spec, sub, value[k], `${loc}.${k}`);
    }
  }
  if ((resolved.type === "array" || (Array.isArray(resolved.type) && resolved.type.includes("array"))) && Array.isArray(value) && resolved.items) {
    value.forEach((item, i) => validateAgainst(spec, resolved.items, item, `${loc}[${i}]`));
  }
}

export function validateCompanionResponse(method, apiPath, json) {
  if (apiPath === "/api/v1/ws") return json;
  if (json === null || json === undefined) {
    throw new CompanionApiError("schema", `Companion ${apiPath} returned empty JSON`, { path: apiPath });
  }
  if (typeof json !== "object" || Array.isArray(json)) {
    throw new CompanionApiError("schema", `Companion ${apiPath} JSON must be an object`, { path: apiPath });
  }
  const spec = loadCompanionOpenApi();
  const schema = getResponseSchema(method, apiPath);
  if (!schema) return json;
  validateAgainst(spec, schema, json, apiPath);
  return json;
}

/**
 * Read a contract field. If only a transitional alias is present, return it and note the alias.
 * Missing → { value: undefined, alias: null }.
 */
export function readContractField(obj, contractName, aliases = CONTRACT_FIELD_ALIASES[contractName] || []) {
  if (!obj || typeof obj !== "object") return { value: undefined, alias: null };
  if (Object.prototype.hasOwnProperty.call(obj, contractName) && obj[contractName] !== undefined) {
    return { value: obj[contractName], alias: null };
  }
  for (const a of aliases) {
    if (Object.prototype.hasOwnProperty.call(obj, a) && obj[a] !== undefined) {
      return { value: obj[a], alias: a };
    }
  }
  return { value: undefined, alias: null };
}

export function collectUsedAliases(rawStatus) {
  const used = [];
  if (!rawStatus || typeof rawStatus !== "object") return used;
  const spec = loadCompanionOpenApi();
  const schema = resolveRef(spec, spec.components.schemas.Status);
  const aliasMap = { ...CONTRACT_FIELD_ALIASES };
  Object.assign(aliasMap, collectAliases(schema));
  const visit = (node, prefix) => {
    if (!node || typeof node !== "object") return;
    for (const [contractName, aliases] of Object.entries(CONTRACT_FIELD_ALIASES)) {
      const { alias } = readContractField(node, contractName, aliases);
      if (alias) used.push({ field: prefix ? `${prefix}.${contractName}` : contractName, alias });
    }
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === "object" && !Array.isArray(v)) visit(v, prefix ? `${prefix}.${k}` : k);
    }
  };
  visit(rawStatus, "");
  return used;
}

export { collectAliases };

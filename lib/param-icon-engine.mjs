import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getGeminiModelChain } from './gemini-model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PARAM_ICONS_PATH = path.join(__dirname, '..', 'data', 'param-icons.json');
export const ARDU_PARAMS_PATH = path.join(__dirname, '..', 'data', 'arduplane-params.json');

export const PARAM_ICON_STYLE = `
20x20 viewBox="0 0 20 20", xmlns required.
Monoline aviation HUD pictogram: stroke only, stroke-width 1.5, stroke-linecap round, stroke-linejoin round.
Default stroke #94a3b8; optional single accent stroke #38bdf8 for one highlight element max.
No fill except one small dot (r<=1.5). No text, no gradients, no filters, no images.
Output ONE root <svg>...</svg> only — no markdown, no explanation.
`.trim();

const ALLOWED_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'defs', 'clippath',
]);

const CATEGORY_PREFIXES = [
  [['ARSPD', 'ASPD', 'TECS_SPD'], 'speed'],
  [['THR', 'TKOFF_THR', 'LAND_THR', 'MOT_THST'], 'throttle'],
  [['NAVL1', 'WP_', 'NAV_'], 'nav'],
  [['TECS_HGT', 'ALT_', 'BARO_'], 'altitude'],
  [['EKF', 'AHRS', 'EK3'], 'ekf'],
  [['GPS_'], 'gps'],
  [['BATT'], 'battery'],
  [['RCMAP', 'RCIN', 'RCOUT', 'RC'], 'rc'],
  [['SRV_', 'SERVO'], 'servo'],
  [['COMPASS', 'MAG_'], 'compass'],
  [['FS_', 'FENCE_'], 'safety'],
  [['CAM_', 'CAMERA'], 'camera'],
  [['LOG_'], 'log'],
  [['MIS_', 'CMD_'], 'mission'],
  [['LAND_'], 'land'],
  [['TKOFF_'], 'takeoff'],
  [['PTCH', 'PITCH'], 'pitch'],
  [['RLL', 'ROLL'], 'roll'],
  [['YAW', 'RUDDER'], 'yaw'],
  [['TECS_'], 'tecs'],
  [['PLND_'], 'plnd'],
  [['MOT_'], 'motor'],
  [['SERIAL', 'SER'], 'serial'],
];

export const CATEGORY_SVG = {
  speed: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#38bdf8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h9"/><path d="M10 7l4 3-4 3"/><circle cx="5" cy="10" r="1.2" fill="#38bdf8" stroke="none"/></svg>`,
  throttle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#f97316" stroke-width="1.5" stroke-linecap="round"><rect x="8" y="3" width="4" height="14" rx="1"/><path d="M10 14v2M6 8h8"/></svg>`,
  nav: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="6"/><path d="M10 6v4l3 2"/></svg>`,
  altitude: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#4ade80" stroke-width="1.5" stroke-linecap="round"><path d="M10 4v12M7 7l3-3 3 3M7 13l3 3 3-3"/></svg>`,
  ekf: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#f472b6" stroke-width="1.5" stroke-linecap="round"><path d="M4 14l4-8 4 5 4-9"/><circle cx="16" cy="5" r="1.2" fill="#f472b6" stroke="none"/></svg>`,
  gps: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#34d399" stroke-width="1.5" stroke-linecap="round"><path d="M10 3c3 0 5 2.5 5 5.5S10 17 10 17S5 11.5 5 8.5 7 3 10 3z"/><circle cx="10" cy="8.5" r="1.5" fill="#34d399" stroke="none"/></svg>`,
  battery: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#facc15" stroke-width="1.5" stroke-linecap="round"><rect x="4" y="6" width="11" height="8" rx="1"/><path d="M15 9v2M6 9h5"/></svg>`,
  rc: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#fb923c" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="8" width="14" height="6" rx="2"/><circle cx="7" cy="11" r="1"/><circle cx="13" cy="11" r="1"/></svg>`,
  servo: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="3"/><path d="M10 4v2M10 14v2M4 10h2M14 10h2"/></svg>`,
  compass: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#c084fc" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="6"/><path d="M10 5l1 5-5 1 5-1 1-5z" fill="#c084fc" stroke="none" opacity=".35"/><path d="M10 6v2"/></svg>`,
  safety: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round"><path d="M10 3l6 3v5c0 3.5-2.5 5.5-6 7-3.5-1.5-6-3.5-6-7V6z"/></svg>`,
  camera: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="6" width="14" height="9" rx="1"/><circle cx="10" cy="10.5" r="2.5"/></svg>`,
  log: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#a3e635" stroke-width="1.5" stroke-linecap="round"><path d="M6 4h8v12H6z"/><path d="M8 8h4M8 11h4M8 14h2"/></svg>`,
  mission: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#67e8f9" stroke-width="1.5" stroke-linecap="round"><path d="M4 14l4-10 4 6 4-8"/><circle cx="4" cy="14" r="1" fill="#67e8f9" stroke="none"/><circle cx="16" cy="6" r="1" fill="#67e8f9" stroke="none"/></svg>`,
  land: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#fb7185" stroke-width="1.5" stroke-linecap="round"><path d="M4 14h12"/><path d="M10 5l-4 5h8z"/></svg>`,
  takeoff: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#86efac" stroke-width="1.5" stroke-linecap="round"><path d="M4 14h12"/><path d="M10 15l-4-6h8z"/></svg>`,
  pitch: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#fde68a" stroke-width="1.5" stroke-linecap="round"><path d="M4 10h12"/><path d="M10 6v8M7 9l3-3 3 3M7 11l3 3 3-3"/></svg>`,
  roll: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#ddd6fe" stroke-width="1.5" stroke-linecap="round"><path d="M10 4v12"/><path d="M6 8c2-2 8-2 8 0M6 12c2 2 8 2 8 0"/></svg>`,
  yaw: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#99f6e4" stroke-width="1.5" stroke-linecap="round"><path d="M10 4a6 6 0 1 1 0 12"/><path d="M10 4v3M13 7l-2-1"/></svg>`,
  tecs: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#7dd3fc" stroke-width="1.5" stroke-linecap="round"><path d="M3 14l4-6 3 4 3-7 4 9"/></svg>`,
  plnd: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#f9a8d4" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="2"/><path d="M10 4v2M10 14v2M4 10h2M14 10h2"/><circle cx="10" cy="10" r="6" stroke-dasharray="2 2"/></svg>`,
  motor: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#c4b5fd" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="2"/><path d="M10 3v3M10 14v3M3 10h3M14 10h3M5.5 5.5l2 2M12.5 12.5l2 2M14.5 5.5l-2 2M7.5 12.5l-2 2"/></svg>`,
  serial: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#fdba74" stroke-width="1.5" stroke-linecap="round"><path d="M5 7h10v6H5z"/><path d="M8 10h1M11 10h1"/></svg>`,
  pid_p: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round"><path d="M4 14V6h6a3 3 0 0 1 0 6H6"/></svg>`,
  pid_i: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#fb923c" stroke-width="1.5" stroke-linecap="round"><path d="M5 14c0-4 3-6 5-8 2 2 5 4 5 8"/></svg>`,
  pid_d: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#818cf8" stroke-width="1.5" stroke-linecap="round"><path d="M4 14l5-10 5 6 2-4"/></svg>`,
  default: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#64748b" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="3"/><path d="M10 4v2M10 14v2M4 10h2M14 10h2"/></svg>`,
};

export const COMMON_PARAM_KEYS = [
  'ARSPD_FBW_MIN', 'ARSPD_FBW_MAX', 'ARSPD_CRUISE', 'TRIM_THROTTLE', 'THR_MAX',
  'ROLL_LIMIT_DEG', 'PTCH_LIM_MAX_DEG', 'PTCH_LIM_MIN_DEG', 'GPS_TYPE', 'GPS_HDOP_GOOD',
  'BATT_MONITOR', 'BATT_CAPACITY', 'FS_SHORT_ACTN', 'FS_LONG_ACTN', 'NAVL1_PERIOD',
  'WP_RADIUS', 'LAND_FLARE_SEC', 'TKOFF_THR_MAX', 'EK3_POSNE_M_NSE', 'COMPASS_ENABLE',
  'RC1_MIN', 'SERVO1_FUNCTION', 'TECS_CLMB_MAX', 'RTL_ALTITUDE', 'FENCE_ENABLE',
  'LOG_BITMASK', 'YAW_RATE_ENABLE', 'RLL_RATE_P', 'PTCH_RATE_P', 'AIRSPEED_CRUISE',
  'FLIGHT_MODE_CH', 'ARMING_CHECK', 'BARO_PROBE_EXT', 'CAM_TRIGG_TYPE', 'MIS_TOTAL',
  'NAVL1_DAMPING', 'LAND_PITCH_DEG', 'TKOFF_ALT', 'FS_GCS_ENABL', 'FENCE_ALT_MAX',
  'SERIAL1_PROTOCOL', 'PLND_ENABLED', 'AHRS_EKF_TYPE', 'MAG_ENABLE', 'RCMAP_ROLL',
  'TECS_SPDWEIGHT', 'THR_SLEWRATE', 'WP_LOITER_RAD', 'GLIDE_SLOPE_MIN', 'LAND_FLAP_PERCNT',
];

export function getCategoryForKey(paramKey) {
  const upper = String(paramKey || '').toUpperCase();
  for (const [prefixes, cat] of CATEGORY_PREFIXES) {
    if (prefixes.some((p) => upper.startsWith(p))) return cat;
  }
  if (/_P\b/.test(upper) || upper.endsWith('_P')) return 'pid_p';
  if (/_IMAX$|_I\b/.test(upper) || upper.endsWith('_I')) return 'pid_i';
  if (upper.endsWith('_D')) return 'pid_d';
  return 'default';
}

export function getCategoryFallbackSvg(paramKey) {
  const cat = getCategoryForKey(paramKey);
  return CATEGORY_SVG[cat] || CATEGORY_SVG.default;
}

export function buildParamIconPrompt(paramKey, paramLabel, paramDesc = '') {
  const cat = getCategoryForKey(paramKey);
  return `Design a unique monoline SVG icon for ArduPlane parameter "${paramKey}" (${paramLabel}).
Category hint: ${cat}. ${paramDesc ? `Description: ${paramDesc.slice(0, 200)}` : ''}
${PARAM_ICON_STYLE}
The icon must be visually distinct from generic gear/slider — suggest the parameter's physical meaning (airspeed, battery, GPS, PID, etc.).`;
}

export function extractSvgFromText(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:svg)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : text;
  const start = body.search(/<svg[\s>]/i);
  const end = body.search(/<\/svg>/i);
  if (start < 0 || end < 0) return null;
  return body.slice(start, end + 6);
}

export function sanitizeSvg(svg) {
  let s = String(svg || '').trim();
  if (!/^<svg[\s>]/i.test(s)) return null;
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\s+on\w+="[^"]*"/gi, '')
    .replace(/\s+on\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '');
  if (!/viewBox\s*=/i.test(s) && /width\s*=/i.test(s)) {
    s = s.replace(/<svg/i, '<svg viewBox="0 0 20 20"');
  } else if (!/viewBox\s*=/i.test(s)) {
    s = s.replace(/<svg/i, '<svg viewBox="0 0 20 20"');
  }
  const tagRe = /<\/?([a-zA-Z][\w-]*)/g;
  let m;
  while ((m = tagRe.exec(s)) !== null) {
    const tag = m[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return null;
  }
  if (!s.includes('xmlns=')) {
    s = s.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return s;
}

let _cacheMem = null;

export async function loadParamIconCache() {
  if (_cacheMem) return _cacheMem;
  if (!existsSync(PARAM_ICONS_PATH)) {
    _cacheMem = { _meta: { built_at: null, count: 0 }, icons: {} };
    return _cacheMem;
  }
  try {
    _cacheMem = JSON.parse(await fs.readFile(PARAM_ICONS_PATH, 'utf8'));
    if (!_cacheMem.icons) _cacheMem.icons = {};
    return _cacheMem;
  } catch {
    _cacheMem = { _meta: {}, icons: {} };
    return _cacheMem;
  }
}

export function invalidateParamIconCache() {
  _cacheMem = null;
}

export async function saveParamIconCache(cache) {
  cache._meta = {
    ...cache._meta,
    updated_at: new Date().toISOString(),
    count: Object.keys(cache.icons || {}).length,
  };
  await fs.writeFile(PARAM_ICONS_PATH, JSON.stringify(cache, null, 0), 'utf8');
  _cacheMem = cache;
}

export function resolveSvgForKey(paramKey, cache) {
  const key = String(paramKey || '').toUpperCase();
  const entry = cache?.icons?.[key];
  if (entry?.svg) {
    const clean = sanitizeSvg(entry.svg);
    if (clean) return clean;
  }
  return getCategoryFallbackSvg(key);
}

export function getParamIconManifest(cache) {
  const icons = cache?.icons || {};
  const manifest = {};
  for (const [k, v] of Object.entries(icons)) {
    if (v?.svg) manifest[k] = { custom: true, category: getCategoryForKey(k) };
  }
  return manifest;
}

export async function generateParamIconSvg(apiKey, paramKey, label, desc = '') {
  const genAI = new GoogleGenerativeAI(apiKey);
  const prompt = buildParamIconPrompt(paramKey, label, desc);
  const chain = getGeminiModelChain();
  let lastErr;
  for (const modelId of chain) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        generationConfig: { temperature: 0.35, maxOutputTokens: 1024 },
      });
      const result = await model.generateContent(prompt);
      const raw = result?.response?.text?.() || '';
      const extracted = extractSvgFromText(raw);
      const clean = sanitizeSvg(extracted);
      if (clean) return { svg: clean, model: modelId };
      lastErr = new Error('invalid SVG in model response');
    } catch (err) {
      lastErr = err;
      if (!/503|404|429|quota/i.test(String(err?.message))) break;
    }
  }
  throw lastErr || new Error('icon generation failed');
}

export async function generateAndCacheParamIcon(apiKey, paramKey, label, desc = '') {
  const key = String(paramKey || '').toUpperCase();
  const { svg, model } = await generateParamIconSvg(apiKey, key, label, desc);
  const cache = await loadParamIconCache();
  cache.icons[key] = { svg, model, label, built_at: new Date().toISOString() };
  await saveParamIconCache(cache);
  return cache.icons[key];
}

/**
 * NEW-lane companion proxy wraps successful client calls as `{ ok, lane, data }`.
 * Policy editor hydrate needs the inner document (`channels`) or preview (`snippet`).
 * Config GET/PATCH hydrate needs the inner document (`runtime` / `vision` / `applied`).
 */

/**
 * @param {unknown} json
 * @returns {unknown}
 */
export function unwrapCompanionProxy(json) {
  if (json && typeof json === 'object' && json.data != null && typeof json.data === 'object') {
    return json.data;
  }
  return json;
}

/**
 * @param {unknown} json
 * @returns {object | null} policy document with `.channels`, or null
 */
export function policyDocumentFromProxyJson(json) {
  const doc = unwrapCompanionProxy(json);
  if (doc && typeof doc === 'object' && doc.channels && typeof doc.channels === 'object') {
    return doc;
  }
  return null;
}

/**
 * @param {unknown} json
 * @returns {object | null} companion config (or runtime PATCH result) after envelope unwrap
 */
export function companionConfigFromProxyJson(json) {
  const doc = unwrapCompanionProxy(json);
  if (!doc || typeof doc !== 'object') return null;
  if (doc.runtime != null || doc.static != null || doc.vision != null || doc.read_only != null) {
    return doc;
  }
  return null;
}

/**
 * RTL / BiDi helpers for Hebrew chrome that must keep English product names
 * (AIRVIX Ask, GO) as isolated LTR islands. Marks are Unicode isolates, not
 * new product copy.
 */

export const BIDI_FSI = '\u2068';
export const BIDI_PDI = '\u2069';
export const BIDI_RLM = '\u200F';

export const ASK_LTR_TOKENS = Object.freeze(['AIRVIX Ask', 'GO', 'Jetson']);

export function isolateLtrToken(token) {
  const s = String(token ?? '');
  if (!s) return '';
  return `${BIDI_FSI}${s}${BIDI_PDI}`;
}

export function rtlMarkEndPunct(text) {
  return String(text ?? '').replace(/([.!?…]+)(\s*)$/u, `${BIDI_RLM}$1$2`);
}

export function rtlSafeAskText(text, extraTokens) {
  const extras = Array.isArray(extraTokens) ? extraTokens : [];
  const tokens = [...ASK_LTR_TOKENS, ...extras]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let out = String(text ?? '');
  for (const tok of tokens) {
    if (!out.includes(tok)) continue;
    out = out.split(tok).join(isolateLtrToken(tok));
  }
  return rtlMarkEndPunct(out);
}

const KEY_VALUE_RE = /cursor_[A-Za-z0-9_-]{16,}/g;
const ENV_ASSIGN_RE = /CURSOR_API_KEY[=:\s]+\S+/gi;

export function redactSecrets(text, extraSecrets = []) {
  let s = String(text ?? '');
  for (const secret of extraSecrets) {
    const token = String(secret || '');
    if (token.length >= 8) s = s.split(token).join('[REDACTED]');
  }
  s = s.replace(ENV_ASSIGN_RE, 'CURSOR_API_KEY=[REDACTED]');
  s = s.replace(KEY_VALUE_RE, '[REDACTED]');
  return s;
}

export function containsSecret(text, extraSecrets = []) {
  const s = String(text ?? '');
  if (KEY_VALUE_RE.test(s)) return true;
  KEY_VALUE_RE.lastIndex = 0;
  for (const secret of extraSecrets) {
    const token = String(secret || '');
    if (token.length >= 8 && s.includes(token)) return true;
  }
  return false;
}

export function assertNoSecrets(value, extraSecrets = []) {
  const dump = typeof value === 'string' ? value : JSON.stringify(value);
  if (containsSecret(dump, extraSecrets)) {
    throw new Error('refusing to serialize secret');
  }
  return value;
}

export function publicUnavailableReason(reason, extraSecrets = []) {
  const redacted = redactSecrets(reason, extraSecrets)
    .replace(/[A-Za-z]:\\[^\s]+/g, '[path]')
    .replace(/\/mnt\/[a-z]\/[^\s]+/g, '[path]')
    .replace(/\/(?:home|root|tmp)\/[^\s]*/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = redacted.slice(0, 240);
  if (!clipped) return 'Development agent unavailable';
  if (/unavailable/i.test(clipped) || /WSL|Node|SDK|distribution|sandbox/i.test(clipped)) {
    return clipped.startsWith('Development agent unavailable')
      ? clipped
      : `Development agent unavailable: ${clipped}`;
  }
  return `Development agent unavailable: ${clipped}`;
}

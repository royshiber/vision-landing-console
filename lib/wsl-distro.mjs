const DISTRO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidDistroName(name) {
  return DISTRO_NAME_RE.test(String(name ?? '').trim());
}

export function assertValidDistroName(name) {
  const value = String(name ?? '').trim();
  if (!isValidDistroName(value)) throw new Error('invalid WSL distribution name');
  return value;
}

/**
 * `wsl.exe` writes UTF-16LE on Windows. Buffers are decoded here so callers do
 * not have to guess the encoding of `wsl -l -v` output.
 */
export function decodeWslOutput(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.replace(/\0/g, '');
  const buf = Buffer.from(raw);
  const nulls = buf.slice(0, Math.min(buf.length, 64)).filter((b) => b === 0).length;
  const text = nulls > 4 ? buf.toString('utf16le') : buf.toString('utf8');
  return text.replace(/\0/g, '');
}

/**
 * Parses `wsl --list --verbose`. The default distribution is the one marked
 * with `*`, which is the only unambiguous discovery signal WSL provides.
 */
export function parseWslVerboseList(rawOutput) {
  const text = decodeWslOutput(rawOutput);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const distros = [];
  for (const line of lines) {
    const isDefault = line.startsWith('*');
    const body = (isDefault ? line.slice(1) : line).trim();
    const parts = body.split(/\s{1,}/).filter(Boolean);
    if (parts.length < 2) continue;
    const name = parts[0];
    if (!isValidDistroName(name)) continue;
    const state = parts[1];
    if (!/^(Running|Stopped|Installing|Converting)$/i.test(state)) continue;
    distros.push({ name, isDefault, state, version: parts[2] || null });
  }
  return distros;
}

export function resolveWslDistro({ configured, distros } = {}) {
  const list = Array.isArray(distros) ? distros : [];
  const wanted = String(configured ?? '').trim();
  if (wanted) {
    if (!isValidDistroName(wanted)) throw new Error('invalid WSL distribution name');
    if (list.length && !list.some((d) => d.name.toLowerCase() === wanted.toLowerCase())) {
      throw new Error(`configured WSL distribution not found: ${wanted}`);
    }
    return wanted;
  }
  if (!list.length) throw new Error('no WSL distribution is installed');
  const defaults = list.filter((d) => d.isDefault);
  if (defaults.length === 1) return defaults[0].name;
  if (list.length === 1) return list[0].name;
  throw new Error('WSL default distribution is ambiguous; set CURSOR_WSL_DISTRO');
}

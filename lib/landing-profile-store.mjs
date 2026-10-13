/**
 * File-backed landing profile for the mock companion and the SITL box.
 * The Jetson process uses scripts/jetson-companion/landing_profile.py.
 * Both reject with rejectJetsonProfile / the shared JSON schema.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rejectJetsonProfile } from './param-schema.mjs';

export function createLandingProfileStore(dir) {
  let memory = null;
  const folder = dir ? String(dir) : '';
  const file = folder ? join(folder, 'landing-profile.json') : '';

  function readRaw() {
    if (!file) return memory;
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function read() {
    const raw = readRaw();
    const profile = raw && raw.profile && typeof raw.profile === 'object' && !Array.isArray(raw.profile)
      ? raw.profile
      : {};
    const present = raw?.present === true && Object.keys(profile).length > 0;
    return { ok: true, present, profile: present ? { ...profile } : {} };
  }

  function write(rawProfile) {
    const verdict = rejectJetsonProfile(rawProfile);
    if (!verdict.ok) return { ok: false, rejected: verdict.rejected };
    const prev = read();
    const profile = { ...(prev.present ? prev.profile : {}), ...verdict.accepted };
    const body = { present: true, profile };
    if (!file) {
      memory = body;
    } else {
      mkdirSync(folder, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(body));
      renameSync(tmp, file);
    }
    return { ok: true, body: { ok: true, present: true, profile } };
  }

  return { read, write };
}

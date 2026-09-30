import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  UPLINK_PATH_LOCK_HE,
  UPLINK_SCREEN_CELL_OTHER_HOME_HE,
  UPLINK_SCREEN_HOME_OTHER_CELL_HE,
} from '../lib/comm-links.mjs';
import { setCompanionUplink } from '../lib/dual-link-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function controlCtx(client, calls) {
  return {
    networkUplinks: {
      wifi: { enabled: true, up: true },
      cellular: { enabled: true, up: true },
    },
    companionService: {
      client,
      getSseOverlay: () => ({ companion: { health: { capabilities: { uplinkControl: true } } } }),
    },
    setNetworkUplink: async (which, body) => {
      calls.push({ which, enabled: body?.enabled });
      return { wifi: { enabled: true }, cellular: { enabled: true } };
    },
  };
}

describe('companion path lock', () => {
  it('refuses to disable the live path until another path answers', async () => {
    const calls = [];
    const snap = {
      activeId: 'home',
      paths: [
        { id: 'home', url: 'http://192.168.1.122:8081', ok: true },
        { id: 'cellular', url: 'http://100.82.59.45:8081', ok: false },
      ],
    };
    const refused = await setCompanionUplink(controlCtx({
      refreshCompanionPaths: async () => snap,
    }, calls), { role: 'home', enabled: false });
    expect(refused.ok).toBe(false);
    expect(refused.status).toBe(409);
    expect(refused.reason).toBe('path_lock');
    expect(refused.messageHe).toBe(UPLINK_SCREEN_HOME_OTHER_CELL_HE);
    expect(UPLINK_SCREEN_HOME_OTHER_CELL_HE).toBe(
      'המסך הזה מחובר ברשת הבית. הסלולר דולק על מחשב המשימה, אבל אין ממנו דרך למסך הזה.',
    );
    expect(refused.messageHe).not.toBe(UPLINK_PATH_LOCK_HE);
    expect(refused.messageHe).not.toMatch(/\.env|docs\/|Jetson/);
    expect(calls).toEqual([]);
  });

  it('keeps the old sentence when the other uplink is not up', async () => {
    const calls = [];
    const snap = {
      activeId: 'home',
      paths: [
        { id: 'home', url: 'http://192.168.1.122:8081', ok: true },
        { id: 'cellular', url: 'http://100.82.59.45:8081', ok: false },
      ],
    };
    const down = {
      networkUplinks: {
        wifi: { enabled: true, up: true },
        cellular: { enabled: true, up: false },
      },
      companionService: {
        client: { refreshCompanionPaths: async () => snap },
        getSseOverlay: () => ({ companion: { health: { capabilities: { uplinkControl: true } } } }),
      },
      setNetworkUplink: async () => {
        calls.push('posted');
        return {};
      },
    };
    const kept = await setCompanionUplink(down, { role: 'home', enabled: false });
    expect(kept.ok).toBe(false);
    expect(kept.status).toBe(409);
    expect(kept.reason).toBe('path_lock');
    expect(kept.messageHe).toBe(UPLINK_PATH_LOCK_HE);
    expect(UPLINK_PATH_LOCK_HE).toBe('אי אפשר לכבות את הקישור שבשימוש, כי אין עוד דרך פעילה למחשב המשימה.');
    expect(calls).toEqual([]);
  });

  it('names the screen path when cellular is in use and home is up without a path', async () => {
    const calls = [];
    const snap = {
      activeId: 'cellular',
      paths: [
        { id: 'cellular', url: 'http://100.82.59.45:8081', ok: true },
        { id: 'home', url: 'http://192.168.1.122:8081', ok: false },
      ],
    };
    const refused = await setCompanionUplink(controlCtx({
      refreshCompanionPaths: async () => snap,
    }, calls), { role: 'cellular', enabled: false });
    expect(refused.ok).toBe(false);
    expect(refused.status).toBe(409);
    expect(refused.reason).toBe('path_lock');
    expect(refused.messageHe).toBe(UPLINK_SCREEN_CELL_OTHER_HOME_HE);
    expect(UPLINK_SCREEN_CELL_OTHER_HOME_HE).toBe(
      'המסך הזה מחובר בסלולר. רשת הבית דולקת על מחשב המשימה, אבל אין ממנה דרך למסך הזה.',
    );
    expect(calls).toEqual([]);
  });

  it('allows the cut once another path is live', async () => {
    const calls = [];
    const snap = {
      activeId: 'home',
      paths: [
        { id: 'home', url: 'http://192.168.1.122:8081', ok: true },
        { id: 'cellular', url: 'http://100.82.59.45:8081', ok: true },
      ],
    };
    const allowed = await setCompanionUplink(controlCtx({
      refreshCompanionPaths: async () => snap,
    }, calls), { role: 'wifi', enabled: false });
    expect(allowed.ok).toBe(true);
    expect(calls).toEqual([{ which: 'wifi', enabled: false }]);
  });

  it('clears a client-only refusal on the next links paint and keeps a server error', () => {
    const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
    const paint = sliceFunction(js, 'paintCommRows');
    const decide = new Function(sliceFunction(js, 'resolveCommLinkErrorPaint') + '\nreturn resolveCommLinkErrorPaint;')();
    expect(paint).toContain('resolveCommLinkErrorPaint');
    expect(paint).toContain('dataset.clientRefusal');
    expect(js).toContain('clientRefusal: true');
    const stuck = decide({
      currentText: UPLINK_SCREEN_CELL_OTHER_HOME_HE,
      clientRefusal: true,
    });
    expect(stuck).toMatchObject({ text: '', hidden: true, clientRefusal: false, serverError: false });
    const server = decide({
      currentText: UPLINK_PATH_LOCK_HE,
      errorHe: 'אין הגעה לכתובת',
      clientRefusal: true,
    });
    expect(server.text).toBe('אין הגעה לכתובת');
    expect(server.serverError).toBe(true);
    const notice = decide({
      currentText: 'ההגדרה נשמרה בקונסולה. מחשב המשימה עדיין לא תומך בכיבוי קישור מרחוק.',
      clientRefusal: false,
    });
    expect(notice.keep).toBe(true);
    expect(notice.serverError).toBe(false);
  });

  it('still posts when the client cannot probe paths', async () => {
    const calls = [];
    const posted = await setCompanionUplink(controlCtx(null, calls), { role: 'home', enabled: false });
    expect(posted.ok).toBe(true);
    expect(calls).toEqual([{ which: 'wifi', enabled: false }]);
  });
});

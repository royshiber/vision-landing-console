import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const agent = fs.readFileSync(path.join(repoRoot, 'scripts', 'jetson-companion', 'companion_agent.py'), 'utf8');

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

describe('Mission GPS | optical display toggle', () => {
  it('ships a compact display-only GPS | אופטי control on Mission chrome', () => {
    expect(html).toContain('id="missionNavDisplay"');
    expect(html).toContain('id="missionNavDisplayGps"');
    expect(html).toContain('id="missionNavDisplayOptical"');
    expect(html).toContain('id="missionNavDisplayStatus"');
    expect(html).toMatch(/id="missionNavDisplayGps"[^>]*>GPS</);
    expect(html).toMatch(/id="missionNavDisplayOptical"[^>]*>אופטי</);
    expect(html).toContain('תצוגה בלבד. לא מחליף את מקור הניווט בבקר.');
    expect(html).toMatch(/id="missionNavDisplayStatus"[^>]*>--</);
    expect(css).toContain('.mission-nav-display');
    expect(css).toContain('.mission-ops-leading');
  });

  it('persists the preference in localStorage and does not talk to the FC', () => {
    expect(js).toContain("visionLandingNavDisplayV1");
    expect(js).toContain('function setNavDisplayPreference(');
    expect(js).toContain('function applyNavOpticalStatus(');
    const persist = sliceFunction(js, 'persistNavDisplayPreference');
    const apply = sliceFunction(js, 'applyNavOpticalStatus');
    const statusHe = sliceFunction(js, 'opticalNavStatusHeClient');
    const setPref = sliceFunction(js, 'setNavDisplayPreference');
    expect(persist + apply + statusHe + setPref).not.toMatch(/ARM|DISARM|LAND|PARAM_SET|EK3_SRC|VISION_POSITION_ESTIMATE|COMMAND_LONG|\/apply|\/restart/);
    expect(statusHe).toContain("אין מצלמה לניווט אופטי");
    expect(apply).toContain('👁 --');
  });

  it('keeps both map tracks when both fixes are real and never invents optical coords', () => {
    const overlay = sliceFunction(js, 'applyFlightOverlayToMap');
    expect(overlay).toContain('displayPref');
    expect(overlay).toContain('opticalOk');
    expect(overlay).toContain('gpsOk');
    expect(overlay).toContain('bothTracks');
    expect(overlay).toContain('ניווט אופטי');
    expect(js).toContain('function opticalNavHasFixClient(');
    expect(js).toContain('nav.camera_ok === true');
    expect(js).toContain('nav.running === true');
  });

  it('companion observe-only stub stays camera_ok false with null position', () => {
    expect(agent).toContain('def optical_nav_status_payload(');
    expect(agent).toContain('/api/v1/status/optical-nav');
    expect(agent).toContain('"alt_ceiling_m": 300');
    expect(agent).toContain('"ekf_injected": False');
    expect(agent).toContain('"position": None');
    expect(agent).toContain('"velocity": None');
    expect(agent).toContain('shared_with');
    expect(agent).not.toMatch(/VISION_POSITION_ESTIMATE|OPTICAL_FLOW_RAD_send|ekf_injected.: True/);
    expect(agent).not.toMatch(/"camera_ok": True/);
  });
});

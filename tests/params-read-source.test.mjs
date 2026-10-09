import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const js = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/app.js'), 'utf8');

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

describe('parameter read labels the real source', () => {
  it('shows a profile value from the server and an FC value from the FC read', () => {
    const fn = sliceFunction(js, 'profileLivePresentation');
    const { profileLivePresentation } = new Function(`${fn}\nreturn { profileLivePresentation };`)();
    const keys = [
      { key: 'vision_enable_alt_m', state: 'present', value: 12, source: 'companion' },
      { key: 'WPNAV_SPEED', state: 'present', value: 500, source: 'fc' },
      { key: 'flare_alt_m', state: 'missing', source: 'fc' },
    ];
    expect(profileLivePresentation('vision_enable_alt_m', keys)).toEqual({
      text: '12',
      kicker: 'במחשב המשימה',
    });
    expect(profileLivePresentation('WPNAV_SPEED', keys)).toEqual({
      text: '500',
      kicker: 'בבקר',
    });
    expect(profileLivePresentation('flare_alt_m', keys)).toEqual({
      text: 'חסר',
      kicker: 'בבקר',
    });
    expect(profileLivePresentation('missing_key', keys)).toEqual({
      text: 'חסר',
      kicker: 'בבקר',
    });
    expect(profileLivePresentation('missing_key', keys).text).not.toBe('אין חיבור');
    expect(js).toContain('renderParams();');
  });
});

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
    const profile = { vision_enable_alt_m: 12 };
    expect(profileLivePresentation('vision_enable_alt_m', null, profile)).toEqual({
      text: '12',
      kicker: 'במחשב המשימה',
    });
    expect(profileLivePresentation('WPNAV_SPEED', { WPNAV_SPEED: 500 }, profile)).toEqual({
      text: '500',
      kicker: 'בבקר',
    });
    expect(profileLivePresentation('missing_key', {}, {})).toEqual({
      text: 'אין חיבור',
      kicker: 'בבקר',
    });
    expect(js).toContain('renderParams();');
  });
});

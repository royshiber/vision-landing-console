import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

describe('camera stage attribute', () => {
  it('marks optics, horizon, and debrief picture containers with a stable stage', () => {
    for (const stage of ['cam0', 'cam1', 'cam3', 'horizon']) {
      expect(html).toContain(`data-camera-stage="${stage}"`);
    }
    expect(js).toContain('tile.dataset.cameraStage = slot.apiId');
    expect(html).not.toContain('id="flightCommTab"');
  });
});

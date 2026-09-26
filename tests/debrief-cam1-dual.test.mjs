import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const mod = fs.readFileSync(path.join(root, 'public/modules/debrief-cameras.mjs'), 'utf8');

describe('debrief CAM1 dual view', () => {
  it('holds the OV9281 cam1 stream instead of the ingest cam2 tile', () => {
    expect(html).toContain('data-cam="cam1" data-api="cam1"');
    expect(html).not.toContain('data-api="cam2"');
    expect(mod).toContain("apiId: 'cam1'");
    expect(mod).toContain('/api/jetson/v1/cam1/stream.mjpg');
    expect(mod).not.toMatch(/apiId:\s*'cam2'/);
    expect(mod).toContain('slot.hold');
  });
});

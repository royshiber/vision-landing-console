import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
const tracks = fs.readFileSync(path.join(root, 'public/modules/vision-tracks.mjs'), 'utf8');
const zoom = fs.readFileSync(path.join(root, 'public/modules/camera-digital-zoom.mjs'), 'utf8');
const py = fs.readFileSync(path.join(root, 'scripts/jetson-companion/vision_tracks.py'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'scripts/jetson-companion/README.md'), 'utf8');

describe('lock and follow on the gimbal tile', () => {
  it('keeps the video arrows and adds a lock chip with one-click release', () => {
    expect(html).toContain('id="gimbalVideoPad"');
    expect(html).toContain('data-vision-lock-chip');
    expect(html).toContain('data-vision-release');
    expect(html).toContain('>שחררו</button>');
    expect(tracks).toContain('function paintTrackLock');
    expect(tracks).toContain("postLock({ action: 'unlock', camera })");
    expect(tracks).toContain('היגוי כבוי');
    expect(tracks).toContain('[data-vision-release]');
    expect(zoom).toContain('[data-vision-release]');
    expect(css).toContain('.gimbal-track-lock');
    expect(css).toMatch(/\.gimbal-track-lock[\s\S]{0,400}font-size:\s*clamp\(11px/);
  });

  it('clamps and rate-limits gimbal rates and never builds a flight command', () => {
    expect(py).toContain('class GimbalSteerPid');
    expect(py).toContain('STEER_INTERVAL_S = 0.1');
    expect(py).toContain('STEER_LOSS_S = 1.2');
    expect(py).toContain('flight_commands');
    expect(py).not.toMatch(/mavlink|COMMAND_LONG|set_mode/i);
    expect(readme).toContain('VLC_VISION_GIMBAL_STEER=1');
    expect(readme).toContain('sudo systemctl restart airvix-companion');
  });
});

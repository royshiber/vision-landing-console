import { describe, it, expect } from 'vitest';
import path from 'path';
import { storedRelativePathFromAbsolute, publicUploadUrlFromAbsolute } from '../lib/upload-path.mjs';
import { projectRoot, uploadsDir } from '../lib/db.mjs';

describe('upload-path', () => {
  it('storedRelativePathFromAbsolute uses POSIX segments relative to project root', () => {
    const abs = path.join(uploadsDir, 'demo_model.glb');
    const rel = storedRelativePathFromAbsolute(abs);
    expect(rel).not.toMatch(/\\/);
    expect(path.isAbsolute(rel)).toBe(false);
    expect(rel.startsWith('..')).toBe(false);
    expect(rel.endsWith('demo_model.glb')).toBe(true);
  });

  it('publicUploadUrlFromAbsolute rejects paths outside uploads dir', () => {
    expect(() => publicUploadUrlFromAbsolute(path.join(projectRoot, 'server.js'))).toThrow(/upload_outside_uploads_dir/);
  });

  it('publicUploadUrlFromAbsolute returns encoded /uploads URL', () => {
    const abs = path.join(uploadsDir, 'plain.bin');
    const u = publicUploadUrlFromAbsolute(abs);
    expect(u.startsWith('/uploads/')).toBe(true);
    expect(u).not.toContain('\\');
  });
});

/**
 * Normalise filesystem paths written to SQLite / returned to clients as `/uploads/…` URLs.
 * Why: Windows drive letters and backslashes must never leak into public URLs or portable stored_path rows.
 */
import path from 'path';
import { projectRoot, uploadsDir } from './db.mjs';

/**
 * Path relative to project root using POSIX slashes (for DB `stored_path`).
 * Always resolves `absFsPath` first so drive-relative quirks are collapsed.
 *
 * @param {string} absFsPath
 * @returns {string}
 */
export function storedRelativePathFromAbsolute(absFsPath) {
  const resolved = path.resolve(absFsPath);
  const rel = path.relative(projectRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path_outside_project: ${absFsPath}`);
  }
  return rel.split(path.sep).join('/');
}

/**
 * `/uploads/<basename>` — safe public URL segment (basename only; files live flat under uploadsDir).
 *
 * @param {string} absFsPath
 * @returns {string}
 */
export function publicUploadUrlFromAbsolute(absFsPath) {
  const resolved = path.resolve(absFsPath);
  const uploadsResolved = path.resolve(uploadsDir);
  const rel = path.relative(uploadsResolved, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`upload_outside_uploads_dir: ${absFsPath}`);
  }
  const base = path.basename(resolved);
  return `/uploads/${encodeURIComponent(base)}`;
}

#!/usr/bin/env node
/**
 * Air-gap friendly vendor mirror: copy pinned three + es-module-shims from node_modules → public/vendor.
 * Cross-platform (Node fs only — no curl/wget).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const vendorRoot = path.join(root, 'public', 'vendor');

function cpDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function main() {
  const threeRoot = path.join(root, 'node_modules', 'three');
  const threeBuild = path.join(threeRoot, 'build', 'three.module.js');
  const threeJsm = path.join(threeRoot, 'examples', 'jsm');
  const shimsSrc = path.join(root, 'node_modules', 'es-module-shims', 'dist', 'es-module-shims.js');

  if (!fs.existsSync(threeBuild)) {
    console.error('[vendor-sync] missing three — run: npm install three@0.160.0');
    process.exit(1);
  }
  if (!fs.existsSync(threeJsm)) {
    console.error('[vendor-sync] missing three/examples/jsm — npm package incomplete');
    process.exit(1);
  }
  if (!fs.existsSync(shimsSrc)) {
    console.error('[vendor-sync] missing es-module-shims — run: npm install es-module-shims@1.10.0');
    process.exit(1);
  }

  const outThreeBuildDir = path.join(vendorRoot, 'three', 'build');
  fs.mkdirSync(outThreeBuildDir, { recursive: true });
  fs.copyFileSync(threeBuild, path.join(outThreeBuildDir, 'three.module.js'));

  cpDir(threeJsm, path.join(vendorRoot, 'three', 'examples', 'jsm'));

  const outShims = path.join(vendorRoot, 'es-module-shims');
  fs.mkdirSync(outShims, { recursive: true });
  fs.copyFileSync(shimsSrc, path.join(outShims, 'es-module-shims.js'));

  console.log('[vendor-sync] OK → public/vendor/three/build/three.module.js');
  console.log('[vendor-sync] OK → public/vendor/three/examples/jsm/ (full tree)');
  console.log('[vendor-sync] OK → public/vendor/es-module-shims/es-module-shims.js');
}

main();

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const allowed = new Set(['test-server.mjs', 'test-server-lint.test.mjs']);

const portAssign = /(?:^|[^\w.])PORT\s*=\s*(?:process\.env\.[A-Za-z0-9_]+\s*\|\|\s*)?['"]?\d{2,5}\b/;
const portKey = /(?:^|[^\w.])PORT\s*:\s*['"]?\d{2,5}\b/;
const fixedUrl = /http:\/\/127\.0\.0\.1:40\d{2}\b/;
const fixedListen = /\.listen\(\s*(?!0\b)\d{2,5}\b/;
const fixedTcp = /tcp:\d{2,5}\b/;
const fixedCall = /\b(?:openFlight|startServer|startConsole)\(\s*['"]\d{4,5}['"]/;
const spawnArgPort = /\bspawn(?:Sync)?\([^;\n]*['"]\d{4,5}['"]/;
const consoleSpawn = /server\.js/;

function testFiles(dir) {
  const found = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) found.push(...testFiles(full));
    else if (name.endsWith('.mjs') || name.endsWith('.js')) found.push(full);
  }
  return found;
}

function lineHits(text) {
  const hits = [];
  const rules = [
    ['PORT assignment', portAssign],
    ['PORT key', portKey],
    ['fixed url', fixedUrl],
    ['listen port', fixedListen],
    ['tcp bind', fixedTcp],
    ['port argument', fixedCall],
    ['spawn arg port', spawnArgPort],
  ];
  text.split('\n').forEach((line, index) => {
    if (consoleSpawn.test(line) && /spawn\(|execPath/.test(line)) {
      hits.push(`${index + 1}: console spawn: ${line.trim()}`);
    }
    for (const [label, rule] of rules) {
      if (rule.test(line)) hits.push(`${index + 1}: ${label}: ${line.trim()}`);
    }
  });
  return hits;
}

describe('test server port lint', () => {
  it('no test file hardcodes a console listen port', () => {
    const hits = [];
    for (const file of testFiles(testsDir)) {
      const name = path.basename(file);
      if (allowed.has(name)) continue;
      const found = lineHits(fs.readFileSync(file, 'utf8'));
      if (found.length) hits.push(`${path.relative(testsDir, file)}\n${found.join('\n')}`);
    }
    expect(hits).toEqual([]);
  });
});

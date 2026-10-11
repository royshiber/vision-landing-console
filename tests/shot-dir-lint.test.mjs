import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const banned = '/opt/cursor/' + 'artifacts';

function testFiles(dir) {
  const found = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) found.push(...testFiles(full));
    else if (name.endsWith('.mjs') || name.endsWith('.js')) found.push(full);
  }
  return found;
}

describe('screenshot path lint', () => {
  it('no test file contains the fixed artifacts directory', () => {
    const hits = [];
    for (const file of testFiles(testsDir)) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes(banned)) hits.push(path.relative(testsDir, file));
    }
    expect(hits).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BANNED_STEMS,
  formatReport,
  loadBaseline,
  newOffenders,
  scanText,
  scanUi,
} from '../scripts/hebrew-copy-scan.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const glossary = fs.readFileSync(path.join(repoRoot, 'docs/hebrew-copy-glossary.md'), 'utf8');
const baselinePath = path.join(repoRoot, 'tests/hebrew-copy-baseline.json');

describe('hebrew copy glossary', () => {
  it('prints current calques and fails only on terms outside the baseline', () => {
    const hits = scanUi(repoRoot);
    const baseline = loadBaseline(baselinePath);
    const added = newOffenders(hits, baseline);
    console.log(formatReport(hits));
    expect(added, formatReport(added)).toEqual([]);
    expect(hits.length).toBeGreaterThan(0);
    expect(baseline.length).toBeGreaterThan(0);
  });

  it('rejects a banned term that is not in the baseline', () => {
    const baseline = [{ file: 'public/app.js', text: 'חסר אסימון' }];
    const hits = [
      { file: 'public/app.js', text: 'חסר אסימון' },
      { file: 'public/new.js', text: 'אסימון חדש' },
    ];
    expect(newOffenders(hits, baseline).map((hit) => hit.text)).toEqual(['אסימון חדש']);
  });

  it('allows a known line to stay and ignores a calque that was removed', () => {
    const baseline = [
      { file: 'a.js', text: 'אסימון' },
      { file: 'a.js', text: 'אסימון' },
      { file: 'b.js', text: 'ענף' },
    ];
    const hits = [
      { file: 'a.js', text: 'אסימון' },
      { file: 'a.js', text: 'אסימון' },
    ];
    expect(newOffenders(hits, baseline)).toEqual([]);
  });

  it('keeps the glossary aligned with the scanner stems', () => {
    for (const entry of BANNED_STEMS) {
      expect(glossary).toContain(entry.stem);
      expect(glossary).toContain(entry.approved);
    }
    expect(glossary).toContain('הזינו');
    expect(glossary).toContain('בקר טיסה');
    expect(glossary).toContain('קוד יציאה');
    expect(glossary).toContain('יציאת PWM');
    expect(glossary).toContain('would actually say out loud');
  });

  it('uses endpoint in English and הגדרות in UI copy', () => {
    const radio = scanText('public/index.html', '<span>Jetson אינו נקודת קצה רדיו</span>');
    expect(radio[0].suggested).toBe('Jetson אינו endpoint רדיו');
    const edge = scanText('public/app.js', "hint.textContent = 'גררו קצה לשינוי גודל. גררו כותרת להחלפה. גם בטיסה.'");
    expect(edge[0].suggested).toContain('גררו את הפינה לשינוי גודל');
    expect(edge[0].suggested).not.toContain('קצה');
    const ui = scanText('public/index.html', '<button>שמור תצורה</button>');
    expect(ui[0].suggested).toBe('שמור הגדרות');
    const wizard = scanText('public/index.html', '<button>אשף קונפיגורציה</button>');
    expect(wizard[0].suggested).toBe('אשף הגדרות');
    const prompt = scanText('lib/auto-config-recipes.mjs', 'אתה מהנדס תצורה ArduPilot מומחה.');
    expect(prompt[0].suggested).toBe('אתה מהנדס קונפיגורציה ArduPilot מומחה.');
    expect(scanText('lib/auto-config-recipes.mjs', "labels: 'אשף קונפיגורציה'")).toEqual([]);
  });

  it('suggests the token sentence and the search sentence', () => {
    const token = scanText('x.js', "hint: 'חסר אסימון. הזינו אותו במתקדם.'");
    expect(token[0].suggested).toBe('חסר טוקן. הזינו אותו במתקדם.');
    const search = scanText('y.js', "message: 'חסרה מחרוזת חיפוש'");
    expect(search[0].suggested).toBe('חסר טקסט לחיפוש');
  });
});

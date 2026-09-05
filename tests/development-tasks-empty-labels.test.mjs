import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function htmlElementInnerText(html, tag, id) {
  const re = new RegExp(`<${tag}\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = html.match(re);
  expect(m, `missing <${tag} id="${id}">`).toBeTruthy();
  return m[1].replace(/<[^>]+>/g, '').trim();
}

describe('Development Tasks empty-state chrome', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

  it('uses Hebrew empty-state copy for the task list and audit list', () => {
    const listEmpty = htmlElementInnerText(html, 'p', 'devTaskListEmpty');
    const auditEmpty = htmlElementInnerText(html, 'p', 'devTaskAuditEmpty');
    expect(listEmpty).toBe('אין משימות. צרו משימה למעלה.');
    expect(auditEmpty).toBe('אין רשומות ביקורת');
    expect(listEmpty).not.toBe('No tasks');
    expect(listEmpty).toContain('אין משימות');
    expect(auditEmpty).not.toBe('No audit entries');
  });
});

import { describe, it, expect } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  DEVELOP_FREE_TEXT_ID,
  DEVELOP_FREE_TEXT_LABEL,
  DEVELOP_GATE_JETSON,
  DEVELOP_GATE_FC,
  createDevelopChatEngine,
} from '../lib/develop-chat.mjs';
import { registerDevelopChatApi } from '../lib/routes/develop-chat-api.mjs';
import { createDevelopmentTaskStore } from '../lib/development-task-store.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const version = fs.readFileSync(path.join(repoRoot, 'version.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(repoRoot, 'public', 'changelog.json'), 'utf8');
const commercial = fs.readFileSync(path.join(repoRoot, 'docs', 'COMMERCIAL_CAPABILITIES.he.md'), 'utf8');

function developmentPanel() {
  const start = html.indexOf('id="development"');
  expect(start, 'missing #development').toBeGreaterThanOrEqual(0);
  const from = html.lastIndexOf('<section', start);
  const flights = html.indexOf('id="flights"', start);
  return html.slice(from, flights);
}

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('AIRVIX 1.02.278 Develop Concept B chat', () => {
  it('pins APP_VERSION at 1.02.295', () => {
    expect(version).toContain("export const APP_VERSION = '1.02.295'");
    expect(pkg.version).toBe('1.02.295');
    expect(changelog).toContain('"version": "1.02.278"');
  });

  it('makes chat + live preview the primary Develop surface', () => {
    const panel = developmentPanel();
    expect(panel).toContain('data-develop-chat="b"');
    expect(panel).toContain('class="develop-chat-pane"');
    expect(panel).toContain('class="develop-preview-pane evolve-preview"');
    expect(panel).toContain('id="developChatLog"');
    expect(panel).toContain('id="developChatInput"');
    expect(panel).toContain('id="developChatMcq"');
    expect(panel).toContain('id="developGateJetsonBtn"');
    expect(panel).toContain('id="developGateFcBtn"');
    expect(panel).toContain('אשר העלאה לג׳טסון');
    expect(panel).toContain('אשר התקנה ל-FC');
    expect(panel).toContain('פתח בפרמטרים');
    expect(panel).toContain('תצוגה חיה');
    expect(panel).toContain('class="develop-live-canvas"');
    expect(panel).toContain('id="developInstallPayload"');
    expect(panel).toMatch(/id="developGateJetsonBtn"[^>]*disabled/);
    expect(panel).toMatch(/id="developGateFcBtn"[^>]*disabled/);
    expect(panel).toContain('class="cap-studio" hidden');
    expect(panel).toContain('class="cap-draft-card" hidden');
    expect(css).toMatch(/"preview chat"/);
    expect(js).toContain('function developChatSend(');
    expect(js).toContain('function developChatChoose(');
    expect(js).toContain('function developChatApproveGate(');
    expect(js).toContain('או כתוב חופשי');
    expect(js).toContain('develop-mcq-letter');
    expect(js).toContain('allowed');
    expect(panel).toContain('מה יותקן');
    expect(panel).toContain('ההתקנה מותרת אחרי אימות');
  });

  it('keeps Ask as flight advisor naming and hides מסייע', () => {
    const panel = developmentPanel();
    expect(panel).toContain('AIRVIX Ask');
    expect(panel).not.toContain('מסייע');
    expect(html.includes('מסייע')).toBe(false);
    expect(js.includes('מסייע')).toBe(false);
    expect(commercial).toContain('שיחה ותצוגה חיה');
  });

  it('never auto-applies Jetson or FC from chat gates', () => {
    const src = [
      sliceFunction(js, 'developChatApproveGate'),
      sliceFunction(js, 'developChatMaybeBuild'),
      sliceFunction(js, 'developOpenParams'),
    ].join('\n');
    expect(src).not.toMatch(/\/apply|\/restart|\bARM\b|\bDISARM\b|\bLAND\b|PARAM_SET|JETSON_COMPANION|CURSOR_API_KEY/);
    expect(js).toContain('אין החלה אוטומטית');
    expect(html).not.toMatch(/id="companionApplyBtn"|id="companionRestartBtn"/);
  });
});

describe('Develop Concept B conversation engine', () => {
  it('asks MCQ with always-available free text and keeps gates disabled', () => {
    const engine = createDevelopChatEngine();
    const first = engine.turn(null, { text: 'אני רוצה אזורי נחיתה על המפה' });
    expect(first.phase).toBe('clarify');
    expect(first.pendingQuestion.options.map((o) => o.id)).toContain(DEVELOP_FREE_TEXT_ID);
    expect(first.pendingQuestion.options.some((o) => o.label === DEVELOP_FREE_TEXT_LABEL)).toBe(true);
    expect(first.gates.jetson_upload.enabled).toBe(false);
    expect(first.gates.fc_install.enabled).toBe(false);
    expect(first.gates.jetson_upload.label).toBe(DEVELOP_GATE_JETSON.label);
    expect(first.gates.fc_install.label).toBe(DEVELOP_GATE_FC.label);

    const second = engine.turn(first.id, { choiceId: 'mission' });
    expect(second.phase).toBe('clarify');
    expect(second.pendingQuestion.options.map((o) => o.id)).toContain(DEVELOP_FREE_TEXT_ID);
    expect(second.gates.jetson_upload.enabled).toBe(false);

    const third = engine.turn(second.id, { text: 'רק תצוגה בלי כתיבה לבקר' });
    expect(third.phase).toBe('awaiting_build');
    expect(third.pendingQuestion).toBe(null);
    expect(third.gates.jetson_upload.enabled).toBe(false);
    expect(third.gates.fc_install.enabled).toBe(false);
  });

  it('enables gate buttons only after ready and never applies', () => {
    const engine = createDevelopChatEngine();
    let session = engine.turn(null, { text: 'שכבת תצוגה למחשב משימה' });
    session = engine.turn(session.id, { choiceId: 'pulse' });
    session = engine.turn(session.id, { choiceId: 'display_only' });
    expect(() => engine.approveGate(session.id, 'jetson_upload')).toThrow(/כבוי/);
    engine.markBuilding(session.id);
    session = engine.markReady(session.id, { taskId: 'task-1' });
    expect(session.phase).toBe('ready');
    expect(session.gates.jetson_upload.enabled).toBe(true);
    expect(session.gates.fc_install.enabled).toBe(true);
    expect(session.gates.jetson_upload.approved).toBe(true);
    expect(session.gates.fc_install.approved).toBe(true);
    expect(session.gates.jetson_upload.applied).toBe(false);
    expect(session.install.authorized).toBe(true);
    expect(session.install.jetson.items.length).toBeGreaterThan(0);
    expect(session.install.note).toContain('אין פקודת טיסה');
    expect(session.install.progress.jetson_upload.status).toBe('allowed');
    expect(session.install.progress.fc_install.status).toBe('allowed');
    const approved = engine.approveGate(session.id, 'jetson_upload');
    expect(approved.gates.jetson_upload.approved).toBe(true);
    expect(approved.gates.jetson_upload.applied).toBe(false);
    expect(approved.gates.fc_install.applied).toBe(false);
    expect(approved.install.progress.jetson_upload.status).toBe('recorded');
    expect(approved.install.progress.jetson_upload.percent).toBe(100);
  });
});

describe('Develop Concept B HTTP API', () => {
  it('builds after clarify and refuses gate apply until ready', async () => {
    const engine = createDevelopChatEngine();
    const store = createDevelopmentTaskStore({
      filePath: path.join(os.tmpdir(), `vlc-devchat-${Date.now()}.json`),
    });
    const app = express();
    app.use(express.json());
    registerDevelopChatApi(app, {
      developChatEngine: engine,
      developmentTaskStore: store,
      skipRuntime: true,
    });
    const server = await listen(app);
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const first = await fetch(`${base}/api/develop/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'אזורי נחיתה על המפה' }),
      }).then((r) => r.json());
      expect(first.ok).toBe(true);
      expect(first.session.pendingQuestion.options.some((o) => o.label === DEVELOP_FREE_TEXT_LABEL)).toBe(true);
      expect(first.session.gates.jetson_upload.enabled).toBe(false);

      const earlyGate = await fetch(`${base}/api/develop/chat/${first.session.id}/gate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gateId: 'jetson_upload' }),
      });
      expect(earlyGate.status).toBe(409);

      await fetch(`${base}/api/develop/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: first.session.id, choiceId: 'mission' }),
      });
      await fetch(`${base}/api/develop/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: first.session.id, text: 'תצוגה בלבד' }),
      });

      const built = await fetch(`${base}/api/develop/chat/${first.session.id}/build`, {
        method: 'POST',
      }).then((r) => r.json());
      expect(built.ok).toBe(true);
      expect(built.applied).toBe(false);
      expect(built.session.gates.jetson_upload.enabled).toBe(true);
      expect(built.session.params.length).toBeGreaterThan(0);
      expect(built.session.install.authorized).toBe(true);
      expect(built.session.install.jetson.items.length).toBeGreaterThan(0);
      expect(built.session.install.progress.jetson_upload.status).toBe('allowed');
      expect(built.session.install.progress.fc_install.status).toBe('allowed');
      expect(built.session.gates.jetson_upload.approved).toBe(true);
      expect(built.session.gates.jetson_upload.applied).toBe(false);
      expect(built.task?.taxonomy).toBe('FEATURE');

      const gated = await fetch(`${base}/api/develop/chat/${first.session.id}/gate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gateId: 'fc_install' }),
      }).then((r) => r.json());
      expect(gated.ok).toBe(true);
      expect(gated.applied).toBe(false);
      expect(gated.autoApply).toBe(false);
      expect(gated.session.gates.fc_install.approved).toBe(true);
      expect(gated.session.gates.fc_install.applied).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

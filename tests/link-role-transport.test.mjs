import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from '../lib/db.mjs';
import {
  bucketLinkStatuses,
  displayedLinkRole,
  linkRoleNotice,
  persistConnectionLinkRole,
  savedLinkRole,
} from '../lib/link-attribution.mjs';
import { summarizeCommLinks } from '../lib/comm-links.mjs';
import { summarizeDualLink } from '../lib/dual-link.mjs';
import {
  closeCompanionMavlinkRelay,
  openCompanionMavlinkRelay,
} from '../lib/companion-mavlink-relay.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tailscaleRelay = {
  id: 7,
  name: 'Jetson MAVLink relay (100.64.8.8:5770)',
  type: 'tcp',
  host: '100.64.8.8',
  port: 5770,
  linkRole: 'radio',
  connected: true,
  heartbeatCount: 4,
  lastHeartbeatAgeMs: 200,
};

describe('link role follows the real transport', () => {
  it('shows a Tailscale relay as cellular without rewriting the saved role', () => {
    const input = { ...tailscaleRelay };
    expect(savedLinkRole(input)).toBe('radio');
    expect(displayedLinkRole(input)).toBe('cellular');
    expect(linkRoleNotice(input)).toBe('נשמר כ\u05be<bdi dir="ltr">RF</bdi> · בפועל עובר בסלולר');
    expect(input.linkRole).toBe('radio');
  });

  it('keeps a serial telemetry radio on RF and a plain saved radio unchanged', () => {
    const radio = {
      id: 2,
      type: 'serial',
      serialPort: '/dev/ttyUSB0',
      linkRole: 'radio',
      connected: true,
    };
    const plain = { id: 3, type: 'udp', host: '127.0.0.1', port: 14550, linkRole: 'radio' };
    expect(displayedLinkRole(radio)).toBe('radio');
    expect(linkRoleNotice(radio)).toBe('');
    expect(linkRoleNotice({ ...radio, linkRole: 'cellular' })).toBe(
      'נשמר כ\u05beסלולר · בפועל עובר ב\u05be<bdi dir="ltr">RF</bdi>',
    );
    expect(displayedLinkRole(plain)).toBe('radio');
    expect(displayedLinkRole({ type: 'telemetry', linkRole: 'cellular' })).toBe('radio');
    const bucket = bucketLinkStatuses([radio, tailscaleRelay, plain]);
    expect(bucket.radio?.id).toBe(2);
    expect(bucket.cellular?.id).toBe(7);
  });

  it('paints the relay on the cellular row and leaves the RF row down', () => {
    const summary = summarizeCommLinks({
      radio: 'disconnected',
      cellular: 'disconnected',
      modemPresent: false,
      radioLive: null,
      cellularLive: tailscaleRelay,
    });
    const cell = summary.rows.find((row) => row.id === 'cellular');
    const radio = summary.rows.find((row) => row.id === 'radio');
    expect(cell.connected).toBe(true);
    expect(cell.shownLinkRole).toBe('cellular');
    expect(cell.savedLinkRole).toBe('radio');
    expect(cell.roleNoticeHe).toBe('נשמר כ\u05be<bdi dir="ltr">RF</bdi> · בפועל עובר בסלולר');
    expect(cell.hintHe).toBe('קישור סלולרי דרך מחשב המשימה');
    expect(cell.hintHe).not.toContain('נשמר כ');
    expect(cell.roleSaveRadio).toBe(false);
    expect(cell.connectionId).toBe(7);
    expect(radio.connected).toBe(false);
    expect(radio.connectionId).toBeUndefined();
    expect(tailscaleRelay.linkRole).toBe('radio');
  });

  it('inserts a new relay as cellular and does not rewrite an existing saved row', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlc-role-'));
    const db = openDatabase(path.join(root, 'app.sqlite'));
    try {
      const existing = db.prepare(
        `INSERT INTO connections (name, type, host, port, serial_port, baud_rate, link_role) VALUES (?,?,?,?,?,?,?)`,
      ).run('saved radio', 'tcp', '100.64.8.8', 5770, null, 57600, 'radio');
      const activated = [];
      const opened = await openCompanionMavlinkRelay({
        db,
        baseUrl: 'http://100.64.8.8:8081',
        activate: async (cfg) => {
          activated.push(cfg);
          return { id: cfg.id, connected: true };
        },
        listStatuses: () => [],
        statusOf: (id) => ({ id, connected: true, heartbeatCount: 1 }),
      });
      expect(opened.ok).toBe(true);
      expect(activated[0].linkRole).toBe('cellular');
      expect(db.prepare(`SELECT link_role FROM connections WHERE id = ?`).get(existing.lastInsertRowid).link_role).toBe('radio');
      expect(db.prepare(`SELECT link_role FROM connections WHERE id = ?`).get(opened.id).link_role).toBe('cellular');

      const matched = persistConnectionLinkRole(db, existing.lastInsertRowid, 'cellular');
      expect(matched.ok).toBe(true);
      expect(matched.savedLinkRole).toBe('cellular');
      expect(matched.shownLinkRole).toBe('cellular');
      expect(matched.roleNoticeHe).toBe('');
      expect(db.prepare(`SELECT link_role FROM connections WHERE id = ?`).get(opened.id).link_role).toBe('cellular');

      const mismatch = persistConnectionLinkRole(db, existing.lastInsertRowid, 'radio');
      expect(mismatch.savedLinkRole).toBe('radio');
      expect(mismatch.shownLinkRole).toBe('cellular');
      expect(mismatch.roleNoticeHe).toBe('נשמר כ\u05be<bdi dir="ltr">RF</bdi> · בפועל עובר בסלולר');
      expect(db.prepare(`SELECT link_role FROM connections WHERE id = ?`).get(existing.lastInsertRowid).link_role).toBe('radio');
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('closes a relay that is already marked cellular', () => {
    const deactivated = [];
    const closed = closeCompanionMavlinkRelay({
      baseUrl: 'http://100.64.8.8:8081',
      deactivate: (id) => { deactivated.push(id); },
      listStatuses: () => [{
        id: 4,
        type: 'tcp',
        host: '100.64.8.8',
        port: 5770,
        linkRole: 'cellular',
        connected: true,
      }],
    });
    expect(closed.closed).toContain(4);
    expect(deactivated).toContain(4);
  });

  it('offers the role in the comms chip menu', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'public/index.html'), 'utf8');
    const js = fs.readFileSync(path.join(repoRoot, 'public/app.js'), 'utf8');
    expect(html).toContain('id="flightLinkRoleNote"');
    expect(html).toContain('id="flightLinkRoleNote" class="flight-link-role-note" dir="rtl"');
    expect(html).toContain('id="flightLinkRoleActions" class="flight-link-role-actions" dir="rtl"');
    expect(html).toContain('שמרו כקישור סלולר');
    expect(html).toContain('שמרו כקישור <bdi dir="ltr">RF</bdi>');
    expect(html).toContain('>קישור</h3>');
    expect(html).not.toContain('שמרו כ-RF');
    expect(js).toContain('function saveFlightLinkRole');
    expect(js).toContain('linkRole: role');
    expect(js).toContain('הקישור נשמר כקישור סלולר.');
    expect(js).toContain('הקישור נשמר כקישור RF.');
    expect(js).not.toContain('התפקיד נשמר');
    expect(js).toContain('radioSave.hidden = row?.roleSaveRadio === false');
    const css = fs.readFileSync(path.join(repoRoot, 'public/styles.css'), 'utf8');
    expect(css).toMatch(/\.flight-link-role-actions button\[hidden\]\s*\{[^}]*display:\s*none/);
    const start = js.indexOf('function flightLinkFacts(');
    const end = js.indexOf('function pluralLinkAction(');
    const facts = new Function(`${js.slice(start, end)}\nreturn flightLinkFacts;`)();
    expect(facts({ quality: { known: true, percent: null, bars: 0 } }).strength).toBe('—');
    expect(facts({ quality: { known: false, percent: 0 } }).strength).toBe('—');
    expect(facts({ quality: { known: true, percent: 0 } }).strength).toBe('0%');
  });

  it('treats a live cellular relay as a modem so the command picker stays available', () => {
    const dual = summarizeDualLink({
      radio: 'connected',
      cellular: 'connected',
      modemPresent: false,
      cellularRelayUp: true,
    });
    expect(dual.cellular).toBe('connected');
    expect(dual.cellularStatusHe).not.toBe('מודם לא מחובר');
    expect(dual.canSelectActive).toBe(true);
    expect(dual.modemPresent).toBe(true);

    const summary = summarizeCommLinks({
      radio: 'connected',
      cellular: 'connected',
      modemPresent: false,
      radioLive: {
        id: 1,
        type: 'serial',
        serialPort: '/dev/ttyUSB0',
        connected: true,
        heartbeatCount: 3,
        lastHeartbeatAgeMs: 100,
      },
      cellularLive: tailscaleRelay,
    });
    const cell = summary.rows.find((row) => row.id === 'cellular');
    expect(summary.modemPresent).toBe(true);
    expect(summary.canSelectActive).toBe(true);
    expect(cell.statusHe).not.toBe('מודם לא מחובר');
    expect(cell.statusHe).not.toBe('אין מודם');
    expect(cell.connected).toBe(true);
    expect(cell.roleSaveRadio).toBe(false);
  });
});

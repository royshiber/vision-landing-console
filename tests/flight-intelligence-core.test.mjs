import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { openDatabase } from '../lib/db.mjs';
import { upsertProfileFact, recordEngineerEvent } from '../lib/engineer-memory.mjs';
import { recordExchange } from '../lib/chat-memory.mjs';
import { buildFlightContext, buildModeInstruction } from '../lib/flight-intelligence-core.mjs';

describe('flight-intelligence-core', () => {
  const tmpPath = path.join(os.tmpdir(), `test-flight-intel-core-${Date.now()}.sqlite`);
  let db;

  beforeAll(() => {
    db = openDatabase(tmpPath);
  });

  it('builds mode instructions for advisor and engineer', () => {
    expect(buildModeInstruction('engineer')).toContain('MODE=ENGINEER');
    expect(buildModeInstruction('advisor')).toContain('MODE=ADVISOR');
  });

  it('includes engineer and advisor memory in unified memory block', () => {
    upsertProfileFact(db, 'pilot.prefers_soft_landings', 'true', { confidence: 0.9, source: 'test' });
    recordEngineerEvent(db, {
      sessionId: 's1',
      eventType: 'gps_glitch',
      summary: 'כשל GPS קצר בגובה 70 מטר',
      tags: 'gps',
    });
    recordExchange(db, {
      question: 'יש לי נדנוד בגישה',
      reply: 'נסה לכוונן NAVL1_DAMPING',
      source: 'test',
      versions: { app: '1.00.001' },
    });

    const context = buildFlightContext({
      db,
      text: 'זה קרה לנו כבר? ומה עם נדנוד בגישה?',
      sessionId: 's1',
      mode: 'engineer',
      versions: { app: '1.00.001' },
      liveContext: { telemetry: { flightMode: 'AUTO' }, jetson: { agentVersion: '2.0.0' }, vision: {}, slam: {} },
    });

    expect(context.memory.unifiedMemoryBlock).toContain('[ENGINEER MEMORY]');
    expect(context.memory.unifiedMemoryBlock).toContain('[ADVISOR MEMORY]');
    expect(context.memory.unifiedMemoryBlock).toContain('pilot.prefers_soft_landings=true');
  });

  afterAll(() => {
    db?.close();
    try { fs.unlinkSync(tmpPath); } catch { /* temp cleanup */ }
  });
});

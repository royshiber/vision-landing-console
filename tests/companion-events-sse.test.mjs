import { describe, expect, it } from 'vitest';
import { CompanionApiError } from '../lib/companion-api-client.mjs';
import { healthyCompanionStatus, healthyVisionResult } from '../lib/companion-mock-fixtures.mjs';
import {
  extractSseDataLines,
  isCompanionEventsStreamUnsupported,
  mergeCompanionEventIntoBundle,
  normalizeCompanionEventEnvelope,
  parseSseFrames,
} from '../lib/companion-events-sse.mjs';

describe('companion events SSE helpers', () => {
  it('parses SSE data frames and keeps an incomplete tail', () => {
    const { events, rest } = parseSseFrames(
      'event: status\ndata: {"event":"status","payload":{"ok":true}}\n\ndata: {"event":"vision"',
    );
    expect(events).toEqual([{ event: 'status', payload: { ok: true } }]);
    expect(rest).toContain('vision');
    expect(extractSseDataLines('data: {"a":1}')).toBe('{"a":1}');
  });

  it('normalizes EventEnvelope and a bare CompanionStatus', () => {
    const status = healthyCompanionStatus();
    expect(normalizeCompanionEventEnvelope({
      api_version: '1',
      event: 'vision',
      timestamp: status.timestamp,
      payload: healthyVisionResult(),
    }).event).toBe('vision');
    const bare = normalizeCompanionEventEnvelope(status);
    expect(bare.event).toBe('status');
    expect(bare.payload.system.cpu_percent).toBe(41.2);
    expect(normalizeCompanionEventEnvelope({ hello: true })).toBeNull();
  });

  it('merges status and sibling event payloads into the mapping bundle', () => {
    const status = healthyCompanionStatus();
    const afterStatus = mergeCompanionEventIntoBundle(
      { companion_version: '0.1.0' },
      { event: 'status', payload: status },
    );
    expect(afterStatus.system.cpu_percent).toBe(41.2);
    expect(afterStatus.companion_version).toBe('0.1.0');
    const afterVision = mergeCompanionEventIntoBundle(afterStatus, {
      event: 'vision',
      payload: healthyVisionResult(),
    });
    expect(afterVision.visionResult.quality.confidence).toBe(0.82);
    const afterMav = mergeCompanionEventIntoBundle(afterVision, {
      event: 'mavlink',
      payload: { connected: false, heartbeat_ok: false },
    });
    expect(afterMav.mavlink.connected).toBe(false);
  });

  it('treats 404, 501, and connection failures as unsupported streams', () => {
    expect(isCompanionEventsStreamUnsupported(new CompanionApiError({
      kind: 'http',
      status: 404,
      message: 'no',
    }))).toBe(true);
    expect(isCompanionEventsStreamUnsupported(new CompanionApiError({
      kind: 'http',
      status: 501,
      message: 'no',
    }))).toBe(true);
    expect(isCompanionEventsStreamUnsupported(new CompanionApiError({
      kind: 'connection',
      message: 'ECONNREFUSED',
    }))).toBe(true);
  });
});

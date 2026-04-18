import { describe, it, expect } from 'vitest';
import { MavlinkConnection } from '../lib/mavlink-connection.mjs';

describe('MavlinkConnection', () => {
  it('נוצר עם פרמטרים נכונים', () => {
    const conn = new MavlinkConnection({ id: 1, name: 'Test', type: 'udp', port: 14550 });
    expect(conn.id).toBe(1);
    expect(conn.type).toBe('udp');
    expect(conn.port).toBe(14550);
    expect(conn.connected).toBe(false);
  });

  it('getStatus מחזיר מבנה נכון', () => {
    const conn = new MavlinkConnection({ id: 2, name: 'FC', type: 'tcp', host: '192.168.1.10', port: 5760 });
    const status = conn.getStatus();
    expect(status).toHaveProperty('id', 2);
    expect(status).toHaveProperty('connected', false);
    expect(status).toHaveProperty('type', 'tcp');
    expect(status).toHaveProperty('lastHeartbeatAt', null);
  });

  it('serial/telemetry נדחה ב-connect()', async () => {
    const conn = new MavlinkConnection({ id: 3, name: 'Serial', type: 'serial', serialPort: 'COM3' });
    await expect(conn.connect()).rejects.toThrow();
  });

  it('disconnect לא זורק שגיאה גם כשאין socket', () => {
    const conn = new MavlinkConnection({ id: 4, name: 'X', type: 'udp', port: 14551 });
    expect(() => conn.disconnect()).not.toThrow();
    expect(conn.connected).toBe(false);
  });
});

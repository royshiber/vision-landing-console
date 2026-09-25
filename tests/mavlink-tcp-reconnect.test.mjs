import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPublicCompanionConnectionStatus } from '../lib/companion-connection.mjs';
import { applyMavlinkRelayHint } from '../lib/companion-mavlink-relay.mjs';
import {
  TCP_RECONNECT_DELAYS_MS,
  activateConnection,
  buildMavlink2Frame,
  deactivateConnection,
  getConnectionStatus,
  getMavlinkConnection,
  tcpReconnectDelayMs,
} from '../lib/mavlink-connection.mjs';

const DELAYS = [40, 80, 120, 160];
const IDS = [];

function fcHeartbeatFrame() {
  const payload = Buffer.from('000000000103510303', 'hex');
  return buildMavlink2Frame(0, payload, 0, 51, 1);
}

function waitFor(fn, ms = 2500) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false;
      try { ok = fn(); } catch (err) { reject(err); return; }
      if (ok) { resolve(); return; }
      if (Date.now() - start > ms) {
        reject(new Error('timed out'));
        return;
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    const onErr = (err) => {
      server.removeListener('listening', onOk);
      reject(err);
    };
    const onOk = () => {
      server.removeListener('error', onErr);
      resolve(server.address().port);
    };
    server.once('error', onErr);
    server.listen(port, '127.0.0.1', onOk);
  });
}

async function closeServer(server, clients) {
  for (const sock of clients) {
    try { sock.destroy(); } catch { /* ignore */ }
  }
  clients.clear();
  if (!server.listening) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

function companionService() {
  return {
    describe: () => ({ mode: 'real', baseUrlConfigured: true, baseUrl: 'http://127.0.0.1:9' }),
    getSseOverlay: () => ({
      companion: {
        reachable: true,
        health: { fc_linked: true, fc_heartbeat: true },
      },
    }),
  };
}

function cachedRelay(id, port) {
  return {
    ok: true,
    id,
    host: '127.0.0.1',
    port,
    connected: true,
    heartbeat: true,
    status_he: 'ממסר הטלמטריה פתוח.',
  };
}

afterEach(() => {
  for (const id of IDS.splice(0)) {
    try { deactivateConnection(id); } catch { /* ignore */ }
  }
});

describe('TCP reconnect backoff', () => {
  it('uses 1s, 2s, 5s, then 10s', () => {
    expect([...TCP_RECONNECT_DELAYS_MS]).toEqual([1000, 2000, 5000, 10000]);
    expect(tcpReconnectDelayMs(0)).toBe(1000);
    expect(tcpReconnectDelayMs(1)).toBe(2000);
    expect(tcpReconnectDelayMs(2)).toBe(5000);
    expect(tcpReconnectDelayMs(3)).toBe(10000);
    expect(tcpReconnectDelayMs(9)).toBe(10000);
  });

  it('reconnects after the server closes and recovers the autopilot heartbeat', async () => {
    const id = 88021;
    IDS.push(id);
    const clients = new Set();
    const frame = fcHeartbeatFrame();
    let sendHeartbeat = true;
    const server = net.createServer((sock) => {
      clients.add(sock);
      sock.on('close', () => clients.delete(sock));
      if (sendHeartbeat) sock.write(frame);
    });
    const port = await listen(server);
    const conn = await activateConnection({
      id,
      name: 'relay-reconnect',
      type: 'tcp',
      host: '127.0.0.1',
      port,
      linkRole: 'radio',
      reconnectDelaysMs: DELAYS,
    });
    await waitFor(() => getConnectionStatus(id)?.sysId === 51 && getConnectionStatus(id)?.heartbeatCount > 0);
    expect(conn._lockedAutopilotSysId).toBe(51);

    sendHeartbeat = false;
    await closeServer(server, clients);
    await waitFor(() => {
      const st = getConnectionStatus(id);
      return st && st.connected === false && st.listening === false
        && st.sysId == null && st.heartbeatCount === 0 && st.lastHeartbeatAt == null;
    });
    expect(conn._lockedAutopilotSysId).toBeNull();
    expect(getMavlinkConnection(id)).toBe(conn);

    const down = buildPublicCompanionConnectionStatus({
      service: companionService(),
      mavlinkRelay: cachedRelay(id, port),
    });
    expect(down.mavlinkRelay.connected).toBe(false);
    expect(down.mavlinkRelay.heartbeat).toBe(false);
    expect(down.mavlinkRelay.ok).toBe(false);
    expect(down.fc_heartbeat).toBe(false);
    expect(down.link.fc_heartbeat).toBe(false);
    expect(down.fc).toBe('unlinked');
    expect(down.fcStatusHe).toBe('מנותק');
    expect(down.link.fcStatusHe).toBe('מנותק');
    const hinted = applyMavlinkRelayHint({
      fc: 'heartbeat',
      fc_heartbeat: true,
      fcStatusHe: 'דופק חי',
      connected: true,
    }, cachedRelay(id, port));
    expect(hinted.fc_heartbeat).toBe(false);
    expect(hinted.mavlinkRelay.connected).toBe(false);
    expect(hinted.fcStatusHe).not.toBe('דופק חי');

    sendHeartbeat = true;
    await listen(server, port);
    await waitFor(() => {
      const st = getConnectionStatus(id);
      return st?.connected === true && st.sysId === 51 && st.heartbeatCount > 0
        && Number(st.lastHeartbeatAgeMs) <= 3000;
    });
    expect(conn._lockedAutopilotSysId).toBe(51);
    const up = buildPublicCompanionConnectionStatus({
      service: companionService(),
      mavlinkRelay: cachedRelay(id, port),
    });
    expect(up.mavlinkRelay.connected).toBe(true);
    expect(up.mavlinkRelay.heartbeat).toBe(true);
    expect(up.link.fc_heartbeat).toBe(true);
    expect(up.fc).toBe('heartbeat');
    await closeServer(server, clients);
  });

  it('does not auto-reconnect after a manual disconnect', async () => {
    const id = 88022;
    IDS.push(id);
    const clients = new Set();
    let accepts = 0;
    const server = net.createServer((sock) => {
      accepts += 1;
      clients.add(sock);
      sock.on('close', () => clients.delete(sock));
      sock.write(fcHeartbeatFrame());
    });
    const port = await listen(server);
    await activateConnection({
      id,
      name: 'relay-manual',
      type: 'tcp',
      host: '127.0.0.1',
      port,
      linkRole: 'radio',
      reconnectDelaysMs: DELAYS,
    });
    await waitFor(() => getConnectionStatus(id)?.heartbeatCount > 0);
    const before = accepts;
    deactivateConnection(id);
    expect(getConnectionStatus(id)).toBeNull();
    await delay(400);
    expect(accepts).toBe(before);
    expect(getMavlinkConnection(id)).toBeNull();
    await closeServer(server, clients);
  });

  it('reports a connected socket with a heartbeat older than 3s as down', async () => {
    const id = 88023;
    IDS.push(id);
    const clients = new Set();
    const server = net.createServer((sock) => {
      clients.add(sock);
      sock.write(fcHeartbeatFrame());
    });
    const port = await listen(server);
    const conn = await activateConnection({
      id,
      name: 'relay-stale',
      type: 'tcp',
      host: '127.0.0.1',
      port,
      linkRole: 'radio',
      reconnectDelaysMs: DELAYS,
    });
    await waitFor(() => getConnectionStatus(id)?.sysId === 51);
    conn.lastHeartbeatAt = new Date(Date.now() - 4000).toISOString();
    const stale = getConnectionStatus(id);
    expect(stale.connected).toBe(true);
    expect(stale.lastHeartbeatAgeMs).toBeGreaterThan(3000);
    const status = buildPublicCompanionConnectionStatus({
      service: companionService(),
      mavlinkRelay: cachedRelay(id, port),
    });
    expect(status.mavlinkRelay.connected).toBe(false);
    expect(status.mavlinkRelay.heartbeat).toBe(false);
    expect(status.mavlinkRelay.error).toBe('heartbeat_stale');
    expect(status.fc_heartbeat).toBe(false);
    expect(status.link.fc_heartbeat).toBe(false);
    expect(status.fcStatusHe).toBe('מנותק');
    await closeServer(server, clients);
  });
});

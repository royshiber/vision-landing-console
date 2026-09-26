import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import {
  isTailscaleCgnatHost,
  jetsonFetch,
  openJetsonWebSocket,
  openMavlinkTcpSocket,
  proxyRouteForTarget,
} from '../lib/jetson-socks.mjs';

const proxyEnv = { JETSON_SOCKS_PROXY: 'socks5h://127.0.0.1:1055' };

describe('Tailscale SOCKS routing', () => {
  it('sends only 100.64.0.0/10 through the proxy', () => {
    expect(isTailscaleCgnatHost('100.82.59.45')).toBe(true);
    expect(isTailscaleCgnatHost('100.64.0.1')).toBe(true);
    expect(isTailscaleCgnatHost('100.127.255.255')).toBe(true);
    expect(isTailscaleCgnatHost('::ffff:100.82.59.45')).toBe(true);
    expect(isTailscaleCgnatHost('100.63.255.255')).toBe(false);
    expect(isTailscaleCgnatHost('100.128.0.1')).toBe(false);
    expect(isTailscaleCgnatHost('192.168.1.122')).toBe(false);
    expect(isTailscaleCgnatHost('10.0.0.5')).toBe(false);
    expect(isTailscaleCgnatHost('8.8.8.8')).toBe(false);
    expect(isTailscaleCgnatHost('example.com')).toBe(false);

    expect(proxyRouteForTarget('192.168.1.122', proxyEnv)).toMatchObject({ via: 'direct', reason: 'not_cgnat' });
    expect(proxyRouteForTarget('8.8.8.8', proxyEnv)).toMatchObject({ via: 'direct', reason: 'not_cgnat' });
    expect(proxyRouteForTarget('100.82.59.45', proxyEnv)).toMatchObject({ via: 'proxy', reason: 'cgnat' });
    expect(proxyRouteForTarget('100.82.59.45', {})).toMatchObject({ via: 'direct', reason: 'unset' });
    expect(proxyRouteForTarget('100.82.59.45', { JETSON_SOCKS_PROXY: '' })).toMatchObject({ via: 'direct', reason: 'unset' });
  });

  it('fetches LAN directly and Tailscale through the SOCKS helper', async () => {
    const fetchImpl = vi.fn(async () => new Response('lan'));
    const socksFetch = vi.fn(async () => new Response('ts', { status: 401 }));
    const lan = await jetsonFetch('http://192.168.1.122:8081/api/v1/health', { method: 'GET' }, {
      env: proxyEnv,
      fetchImpl,
      socksFetch,
    });
    expect(await lan.text()).toBe('lan');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(socksFetch).not.toHaveBeenCalled();

    const ts = await jetsonFetch('http://100.82.59.45:8081/health', { method: 'GET' }, {
      env: proxyEnv,
      fetchImpl,
      socksFetch,
    });
    expect(ts.status).toBe(401);
    expect(socksFetch).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('opens the MAVLink socket through SOCKS only for a CGNAT host', async () => {
    const directNet = { Socket: vi.fn(function Socket() { return { kind: 'direct' }; }) };
    const socksImpl = { createConnection: vi.fn(async () => ({ socket: { kind: 'proxied' } })) };
    const lan = await openMavlinkTcpSocket({
      host: '192.168.1.122',
      port: 5770,
      env: proxyEnv,
      netImpl: directNet,
      socksImpl,
    });
    expect(lan.via).toBe('direct');
    expect(lan.connected).toBe(false);
    expect(socksImpl.createConnection).not.toHaveBeenCalled();

    const ts = await openMavlinkTcpSocket({
      host: '100.82.59.45',
      port: 5770,
      env: proxyEnv,
      netImpl: directNet,
      socksImpl,
    });
    expect(ts.via).toBe('proxy');
    expect(ts.connected).toBe(true);
    expect(ts.socket.kind).toBe('proxied');
    expect(socksImpl.createConnection).toHaveBeenCalledWith(expect.objectContaining({
      destination: { host: '100.82.59.45', port: 5770 },
      proxy: expect.objectContaining({ host: '127.0.0.1', port: 1055, type: 5 }),
    }));
  });

  it('attaches a SOCKS agent only to Tailscale websockets', () => {
    const sockets = [];
    class FakeSocket extends EventEmitter {
      constructor(url, protocols, opts) {
        super();
        this.url = url;
        this.opts = opts;
        sockets.push(this);
      }
    }
    class FakeAgent {
      constructor(href) { this.href = href; }
    }
    openJetsonWebSocket('ws://192.168.1.122:8081/api/v1/ws', {
      env: proxyEnv,
      WebSocketImpl: FakeSocket,
      AgentImpl: FakeAgent,
    });
    openJetsonWebSocket('ws://100.82.59.45:8081/api/v1/ws', {
      env: proxyEnv,
      WebSocketImpl: FakeSocket,
      AgentImpl: FakeAgent,
    });
    expect(sockets[0].opts.agent).toBeUndefined();
    expect(sockets[1].opts.agent.href).toBe('socks5h://127.0.0.1:1055');
  });

  it('keeps the Windows installer on userspace Tailscale without touching DNS', () => {
    const ps1 = fs.readFileSync(path.join(process.cwd(), 'scripts', 'windows', 'install-airvix.ps1'), 'utf8');
    const readme = fs.readFileSync(path.join(process.cwd(), 'scripts', 'windows', 'README-he.txt'), 'utf8');
    expect(ps1).toContain('$needTs = $false');
    expect(ps1).toContain('AIRVIX-Tailscale-Safe');
    expect(ps1).toContain('--tun=userspace-networking');
    expect(ps1).toContain('--socks5-server=localhost:1055');
    expect(ps1).toContain('--outbound-http-proxy-listen=localhost:1056');
    expect(ps1).toContain('JETSON_SOCKS_PROXY');
    expect(ps1).toContain('socks5h://127.0.0.1:1055');
    expect(ps1).toContain('401 counts as reachable');
    expect(ps1).toContain('Get-UserspaceAdminPrompt');
    expect(ps1).not.toMatch(/Start-Service\s+-Name\s+'Tailscale'/);
    expect(ps1).not.toMatch(/\$needTs = \$true/);
    expect(ps1).not.toMatch(/Set-DnsClient|Add-DnsClientNrptRule|\\drivers\\etc\\hosts|netsh\s+interface/i);
    expect(readme).toContain('מצב משתמש');
    expect(readme).toContain('שירות השמות');
  });
});

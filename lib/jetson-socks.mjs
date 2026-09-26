/**
 * Route only Tailscale CGNAT (100.64.0.0/10) through JETSON_SOCKS_PROXY.
 * LAN and internet stay direct. Unset proxy means every target is direct.
 * Does not edit hosts, DNS, or NRPT.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import { SocksClient } from 'socks';
import { SocksProxyAgent } from 'socks-proxy-agent';
import WebSocket from 'ws';

const agents = new Map();

export function isTailscaleCgnatHost(host) {
  let name = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (name.startsWith('::ffff:')) name = name.slice('::ffff:'.length);
  const match = name.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const oct = match.slice(1).map((part) => Number(part));
  if (oct.some((n) => !Number.isInteger(n) || n > 255)) return false;
  return oct[0] === 100 && oct[1] >= 64 && oct[1] <= 127;
}

export function readSocksProxy(env = process.env) {
  const raw = String(env?.JETSON_SOCKS_PROXY || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'socks5:' && parsed.protocol !== 'socks5h:') return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return {
    href: raw,
    host: parsed.hostname,
    port,
    remoteDns: parsed.protocol === 'socks5h:',
  };
}

/** @returns {{ via: 'direct'|'proxy', reason: string, proxy: object|null }} */
export function proxyRouteForTarget(host, env = process.env) {
  const proxy = readSocksProxy(env);
  if (!proxy) return { via: 'direct', reason: 'unset', proxy: null };
  if (!isTailscaleCgnatHost(host)) return { via: 'direct', reason: 'not_cgnat', proxy };
  return { via: 'proxy', reason: 'cgnat', proxy };
}

export function hostnameOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return '';
  }
}

function plainHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.forEach === 'function') {
    const out = {};
    headers.forEach((value, key) => { out[key] = value; });
    return out;
  }
  return { ...headers };
}

export function socksProxyAgentFor(proxy, AgentImpl = SocksProxyAgent) {
  const key = proxy.href;
  if (!agents.has(key)) agents.set(key, new AgentImpl(proxy.href));
  return agents.get(key);
}

export function fetchViaSocks(urlString, init = {}, route, agentFor = socksProxyAgentFor) {
  const target = new URL(urlString);
  const lib = target.protocol === 'https:' ? https : http;
  const agent = agentFor(route.proxy);
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: init.method || 'GET',
      headers: plainHeaders(init.headers),
      agent,
      signal: init.signal,
    }, (incoming) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value == null) continue;
        const list = Array.isArray(value) ? value : [value];
        for (const item of list) headers.append(key, String(item));
      }
      resolve(new Response(Readable.toWeb(incoming), {
        status: incoming.statusCode || 0,
        headers,
      }));
    });
    req.on('error', reject);
    if (init.body != null) req.write(init.body);
    req.end();
  });
}

export function jetsonFetch(url, init = {}, opts = {}) {
  const env = opts.env || process.env;
  const direct = opts.fetchImpl || globalThis.fetch.bind(globalThis);
  const route = proxyRouteForTarget(hostnameOf(url), env);
  if (route.via !== 'proxy') return direct(url, init);
  const via = opts.socksFetch || fetchViaSocks;
  return via(url, init, route);
}

export async function openMavlinkTcpSocket({
  host,
  port,
  env = process.env,
  netImpl = net,
  socksImpl = SocksClient,
} = {}) {
  const route = proxyRouteForTarget(host, env);
  if (route.via !== 'proxy') {
    return { socket: new netImpl.Socket(), connected: false, via: 'direct' };
  }
  const result = await socksImpl.createConnection({
    proxy: {
      host: route.proxy.host,
      port: route.proxy.port,
      type: 5,
    },
    command: 'connect',
    timeout: 8000,
    destination: { host: String(host), port: Number(port) },
  });
  return { socket: result.socket, connected: true, via: 'proxy' };
}

export function openJetsonWebSocket(url, opts = {}) {
  const env = opts.env || process.env;
  const WS = opts.WebSocketImpl || WebSocket;
  const route = proxyRouteForTarget(hostnameOf(url), env);
  const wsOpts = {};
  if (route.via === 'proxy') {
    wsOpts.agent = socksProxyAgentFor(route.proxy, opts.AgentImpl);
  }
  return new WS(url, opts.protocols, wsOpts);
}

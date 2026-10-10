/**
 * Route only Tailscale CGNAT (100.64.0.0/10) through JETSON_COMPANION_SOCKS_PROXY
 * (JETSON_SOCKS_PROXY remains an alias).
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
const directAgents = new Map();
const KEEP_ALIVE_MS = 30_000;

function agentOptions() {
  return {
    keepAlive: true,
    keepAliveMsecs: KEEP_ALIVE_MS,
    maxSockets: 4,
    maxFreeSockets: 4,
    scheduling: 'lifo',
    timeout: KEEP_ALIVE_MS,
  };
}

/** One keep-alive pool per companion origin. Sequential calls reuse one socket. */
export function directKeepAliveAgent(urlString) {
  const target = new URL(String(urlString));
  const origin = target.origin;
  let agent = directAgents.get(origin);
  if (!agent) {
    const lib = target.protocol === 'https:' ? https : http;
    agent = new lib.Agent(agentOptions());
    directAgents.set(origin, agent);
  }
  return agent;
}

export function closeCompanionHttpPools() {
  for (const agent of directAgents.values()) agent.destroy();
  directAgents.clear();
  for (const agent of agents.values()) {
    if (typeof agent.destroy === 'function') agent.destroy();
  }
  agents.clear();
}

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
  const raw = String(env?.JETSON_COMPANION_SOCKS_PROXY || env?.JETSON_SOCKS_PROXY || '').trim();
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

export function socksProxyAgentFor(proxy, AgentImpl = SocksProxyAgent, origin = '') {
  const key = `${proxy.href}\n${origin || ''}`;
  if (!agents.has(key)) {
    agents.set(key, new AgentImpl(proxy.href, agentOptions()));
  }
  return agents.get(key);
}

function fetchWithAgent(urlString, init, agent) {
  const target = new URL(urlString);
  const lib = target.protocol === 'https:' ? https : http;
  const headers = plainHeaders(init.headers);
  let payload = null;
  if (init.body != null) {
    payload = Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body));
    const hasLength = headers['Content-Length'] != null || headers['content-length'] != null;
    if (!hasLength) headers['Content-Length'] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    if (init.signal?.aborted) {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: init.method || 'GET',
      headers,
      agent,
      signal: init.signal,
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value == null) continue;
        const list = Array.isArray(value) ? value : [value];
        for (const item of list) responseHeaders.append(key, String(item));
      }
      resolve(new Response(Readable.toWeb(incoming), {
        status: incoming.statusCode || 0,
        headers: responseHeaders,
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function fetchViaSocks(urlString, init = {}, route, agentFor = socksProxyAgentFor) {
  const target = new URL(urlString);
  const agent = agentFor(route.proxy, SocksProxyAgent, target.origin);
  return fetchWithAgent(urlString, init, agent);
}

export function jetsonFetch(url, init = {}, opts = {}) {
  const env = opts.env || process.env;
  const route = proxyRouteForTarget(hostnameOf(url), env);
  if (route.via !== 'proxy') {
    if (opts.fetchImpl) return opts.fetchImpl(url, init);
    return fetchWithAgent(url, init, directKeepAliveAgent(url));
  }
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

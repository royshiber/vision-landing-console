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
const streamAgents = new Map();
const socksStreamAgents = new Map();
const KEEP_ALIVE_MS = 30_000;
const SHORT_POOL_SOCKETS = 4;
/**
 * After the caller times out, a slow reply may still finish and return the
 * socket to the pool. A companion that never answers must not hold that
 * socket until the agent timeout (30 s).
 */
export const SLOW_SOCKET_GRACE_MS = 3_000;

function agentOptions() {
  return {
    keepAlive: true,
    keepAliveMsecs: KEEP_ALIVE_MS,
    maxSockets: SHORT_POOL_SOCKETS,
    maxFreeSockets: SHORT_POOL_SOCKETS,
    scheduling: 'lifo',
    timeout: KEEP_ALIVE_MS,
  };
}

/** MJPEG and event streams must not occupy the short-request pool. */
function streamAgentOptions() {
  return {
    keepAlive: false,
    maxSockets: Infinity,
  };
}

/**
 * Long-lived companion responses. Checked on the pathname so a query string
 * cannot hide a stream on the short pool.
 */
export function isLongLivedCompanionRequest(urlString) {
  let pathname = '';
  try {
    pathname = new URL(String(urlString)).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return false;
  }
  return pathname.endsWith('/stream.mjpg') || pathname.endsWith('/events');
}

/** One keep-alive pool per companion origin. Sequential short calls reuse one socket. */
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

/** Separate unpooled agent so a viewer cannot take a short-request socket. */
export function directStreamAgent(urlString) {
  const target = new URL(String(urlString));
  const origin = target.origin;
  let agent = streamAgents.get(origin);
  if (!agent) {
    const lib = target.protocol === 'https:' ? https : http;
    agent = new lib.Agent(streamAgentOptions());
    streamAgents.set(origin, agent);
  }
  return agent;
}

export function closeCompanionHttpPools() {
  for (const agent of directAgents.values()) agent.destroy();
  directAgents.clear();
  for (const agent of streamAgents.values()) agent.destroy();
  streamAgents.clear();
  for (const agent of agents.values()) {
    if (typeof agent.destroy === 'function') agent.destroy();
  }
  agents.clear();
  for (const agent of socksStreamAgents.values()) {
    if (typeof agent.destroy === 'function') agent.destroy();
  }
  socksStreamAgents.clear();
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

/** SOCKS sockets for streams and events, not the 4-socket short pool. */
export function socksStreamAgentFor(proxy, origin = '', AgentImpl = SocksProxyAgent) {
  const key = `${proxy.href}\n${origin || ''}`;
  if (!socksStreamAgents.has(key)) {
    socksStreamAgents.set(key, new AgentImpl(proxy.href, streamAgentOptions()));
  }
  return socksStreamAgents.get(key);
}

function abortError() {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Remove only `req` from one queue bucket.
 * Arrays are spliced. Any other shape is edited only where a value is `req`.
 * An opaque bucket is left untouched (fail closed) so other waiters stay queued.
 * @returns {'empty' | 'removed' | false}
 */
function removeMatching(queue, req) {
  if (Array.isArray(queue) || (queue && typeof queue.length === 'number' && typeof queue.splice === 'function')) {
    const list = queue;
    let index = -1;
    if (typeof list.indexOf === 'function') index = list.indexOf(req);
    else {
      for (let i = 0; i < list.length; i += 1) {
        if (list[i] === req) {
          index = i;
          break;
        }
      }
    }
    if (index === -1) return false;
    list.splice(index, 1);
    return list.length === 0 ? 'empty' : 'removed';
  }
  if (!queue || typeof queue !== 'object') return false;

  if (typeof queue.delete === 'function' && typeof queue.has === 'function' && queue.has(req)) {
    queue.delete(req);
    const size = typeof queue.size === 'number' ? queue.size : 1;
    return size === 0 ? 'empty' : 'removed';
  }
  if (typeof queue.delete === 'function' && typeof queue.entries === 'function') {
    let removed = false;
    for (const entry of queue.entries()) {
      if (entry[1] === req) {
        queue.delete(entry[0]);
        removed = true;
      }
    }
    if (removed) {
      const size = typeof queue.size === 'number' ? queue.size : 1;
      return size === 0 ? 'empty' : 'removed';
    }
  }

  let removed = false;
  for (const key of Object.keys(queue)) {
    if (queue[key] === req) {
      delete queue[key];
      removed = true;
    }
  }
  if (!removed) return false;
  return Object.keys(queue).length === 0 ? 'empty' : 'removed';
}

/**
 * Node leaves an aborted ClientRequest in agent.requests until a socket frees.
 * `agent.requests` is an internal array map on Node 20 and 22 (see .nvmrc).
 */
export function dequeueRequest(agent, req) {
  const queues = agent?.requests;
  if (!queues || typeof queues !== 'object') return false;
  let removed = false;
  for (const name of Object.keys(queues)) {
    const result = removeMatching(queues[name], req);
    if (result === 'empty') delete queues[name];
    if (result) removed = true;
  }
  return removed;
}

function fetchWithAgent(urlString, init, agent, { preserveInFlight = false } = {}) {
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
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const succeed = (response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    if (init.signal?.aborted) {
      fail(abortError());
      return;
    }
    let responseStarted = false;
    let graceTimer = null;
    const clearGrace = () => {
      if (!graceTimer) return;
      clearTimeout(graceTimer);
      graceTimer = null;
    };
    const armGrace = () => {
      clearGrace();
      graceTimer = setTimeout(() => {
        graceTimer = null;
        try { req.destroy(); } catch { /* already closed */ }
      }, SLOW_SOCKET_GRACE_MS);
      if (typeof graceTimer.unref === 'function') graceTimer.unref();
    };
    const finishAbandonedBody = (incoming) => {
      const done = () => clearGrace();
      incoming.on('end', done);
      incoming.on('close', done);
      incoming.on('error', done);
      armGrace();
      incoming.resume();
    };
    // The signal is handled here. Passing it to http.request neither removes a
    // queued request nor leaves a slow keep-alive socket reusable.
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: init.method || 'GET',
      headers,
      agent,
    }, (incoming) => {
      responseStarted = true;
      if (settled) {
        finishAbandonedBody(incoming);
        return;
      }
      clearGrace();
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value == null) continue;
        const list = Array.isArray(value) ? value : [value];
        for (const item of list) responseHeaders.append(key, String(item));
      }
      succeed(new Response(Readable.toWeb(incoming), {
        status: incoming.statusCode || 0,
        headers: responseHeaders,
      }));
    });
    const onAbort = () => {
      const err = abortError();
      const queued = dequeueRequest(agent, req);
      const keepSocket = preserveInFlight && !queued && req.socket;
      fail(err);
      if (!keepSocket) {
        clearGrace();
        try { req.destroy(); } catch { /* already closed */ }
        return;
      }
      armGrace();
    };
    if (init.signal) init.signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => fail(err));
    req.on('close', () => {
      clearGrace();
      init.signal?.removeEventListener('abort', onAbort);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export function fetchViaSocks(urlString, init = {}, route, agentFor = socksProxyAgentFor) {
  const target = new URL(urlString);
  const longLived = isLongLivedCompanionRequest(urlString);
  const agent = longLived
    ? socksStreamAgentFor(route.proxy, target.origin)
    : agentFor(route.proxy, SocksProxyAgent, target.origin);
  return fetchWithAgent(urlString, init, agent, { preserveInFlight: !longLived });
}

export function jetsonFetch(url, init = {}, opts = {}) {
  const env = opts.env || process.env;
  const route = proxyRouteForTarget(hostnameOf(url), env);
  if (route.via !== 'proxy') {
    if (opts.fetchImpl) return opts.fetchImpl(url, init);
    const longLived = isLongLivedCompanionRequest(url);
    const agent = longLived ? directStreamAgent(url) : directKeepAliveAgent(url);
    return fetchWithAgent(url, init, agent, { preserveInFlight: !longLived });
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

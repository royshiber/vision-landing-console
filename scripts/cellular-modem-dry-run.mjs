#!/usr/bin/env node
/**
 * Console E3372 honesty dry-run. No hardware required.
 * Detects absent, never invents a cellular link-up, never talks to an FC.
 *
 *   node scripts/cellular-modem-dry-run.mjs
 *   CELLULAR_MODEM_MOCK=present node scripts/cellular-modem-dry-run.mjs
 */
import fs from 'node:fs';
import { probeHuaweiE3372 } from '../lib/cellular-modem.mjs';
import {
  annotatedVideoAvailability,
  cellularConnectGate,
  cellularUpdateReadiness,
  commandLinkOpsPath,
  summarizeDualLink,
} from '../lib/dual-link.mjs';
import { resolveCellularModem } from '../lib/cellular-modem.mjs';

const dry = process.argv.includes('--dry-run') || process.argv.includes('--dry');
const existsSync = dry ? () => false : fs.existsSync;
const modem = probeHuaweiE3372({ env: process.env, existsSync });
const cellular = modem.present ? 'disconnected' : 'modem_absent';
const links = summarizeDualLink({
  radio: 'disconnected',
  cellular,
  modemPresent: modem.present,
});
const video = annotatedVideoAvailability({
  cellular: links.cellular,
  modemPresent: modem.present,
});
const remote = cellularConnectGate({
  modemPresent: modem.present,
  host: '10.0.0.8',
});

const resolved = resolveCellularModem({ local: modem, companionModem: null });
const ops = commandLinkOpsPath({
  active: links.active,
  modemPresent: resolved.present,
  companionReachable: false,
  video,
});
const update = cellularUpdateReadiness({ companionReachable: false });

const snapshot = {
  ok: true,
  dryRun: true,
  model: modem.model,
  present: modem.present,
  reason: modem.reason,
  reasonHe: modem.reasonHe,
  source: resolved.source,
  cellular: links.cellular,
  modemPresent: links.modemPresent,
  video,
  ops,
  update,
  remoteConnect: {
    allowed: remote.allowed,
    mode: remote.mode,
    state: remote.state || null,
  },
  flightCommands: false,
  companionHttpCommandPath: false,
  autoDeployFc: false,
};

process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
process.exit(0);

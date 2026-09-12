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
  summarizeDualLink,
} from '../lib/dual-link.mjs';

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

const snapshot = {
  ok: true,
  dryRun: true,
  model: modem.model,
  present: modem.present,
  reason: modem.reason,
  reasonHe: modem.reasonHe,
  cellular: links.cellular,
  modemPresent: links.modemPresent,
  video,
  remoteConnect: {
    allowed: remote.allowed,
    mode: remote.mode,
    state: remote.state || null,
  },
  flightCommands: false,
  companionHttpCommandPath: false,
};

process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
process.exit(0);

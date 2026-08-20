#!/usr/bin/env node
/**
 * Controlled bootstrap for the Linux-native Cursor agent runtime inside WSL.
 *
 * Development task execution never installs anything: it only verifies
 * readiness. An operator runs this once per machine (and after an SDK version
 * bump). No API key is required or read here.
 *
 *   npm run setup:wsl-agent           install + verify
 *   npm run setup:wsl-agent -- --verify-only
 */
import process from 'process';
import { createWslCursorAgentRuntime } from '../lib/wsl-cursor-agent-runtime.mjs';
import { CURSOR_SDK_PINNED_VERSION } from '../lib/wsl-cursor-runtime-spec.mjs';

function line(label, value) {
  console.log(`${label.padEnd(22)} ${value}`);
}

async function main() {
  const verifyOnly = process.argv.includes('--verify-only');
  const runtime = createWslCursorAgentRuntime({ repoRoot: process.cwd() });

  if (verifyOnly) {
    const health = await runtime.probeHealth({ force: true });
    line('runtime', health.ok ? 'READY' : 'UNAVAILABLE');
    if (health.details) {
      line('distro', health.details.distro);
      line('linux node', health.details.node);
      line('sdk version', health.details.sdkVersion);
      line('platform package', health.details.platformPackage);
      line('sandbox', health.details.sandboxEnabled ? 'enabled' : 'disabled');
    }
    if (!health.ok) {
      line('reason', health.reason || 'unknown');
      process.exitCode = 1;
    }
    return;
  }

  console.log(`Preparing Linux Cursor agent runtime (@cursor/sdk@${CURSOR_SDK_PINNED_VERSION})...`);
  const report = await runtime.prepareRuntime({ install: true });
  line('distro', report.distro);
  line('runtime dir', report.runtimeDir);
  line('installed', report.steps.join(', '));
  line('runtime', report.health.ok ? 'READY' : 'UNAVAILABLE');
  if (report.health.details) {
    line('linux node', report.health.details.node);
    line('sdk version', report.health.details.sdkVersion);
    line('platform package', report.health.details.platformPackage);
    line('sandbox', report.health.details.sandboxEnabled ? 'enabled' : 'disabled');
  }
  if (!report.health.ok) {
    line('reason', report.health.reason || 'unknown');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`WSL runtime setup failed: ${String(err?.message || err)}`);
  process.exitCode = 1;
});

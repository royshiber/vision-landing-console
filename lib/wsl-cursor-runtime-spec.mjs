/**
 * Contract for the Linux-native Cursor agent runtime that lives inside WSL.
 *
 * C9.9-W established that Windows cannot host a sandboxed Cursor agent: the
 * sandbox helper is platform specific and only the Linux platform package
 * supports it. The runtime therefore owns its own Linux-native install and all
 * module resolution has to stay inside that prefix — resolving up a /mnt/c tree
 * reaches the Windows install and silently disables sandbox support.
 */
export const CURSOR_SDK_PINNED_VERSION = '1.0.28';
export const CURSOR_SDK_LINUX_PLATFORM_PACKAGE = '@cursor/sdk-linux-x64';
export const RUNTIME_DIR_RELATIVE = '.airvix/cursor-agent-runtime';
export const RUNTIME_ENTRYPOINT_NAME = 'agent-entrypoint.mjs';
export const RUNTIME_MIN_NODE_MAJOR = 22;
export const RUNTIME_SETUP_HINT = 'run "npm run setup:wsl-agent" on the console host';

export function runtimeDirFor(linuxHome) {
  const home = String(linuxHome || '').replace(/\/+$/, '');
  if (!home.startsWith('/')) throw new Error('linux home directory required');
  return `${home}/${RUNTIME_DIR_RELATIVE}`;
}

export function runtimeEntrypointFor(runtimeDir) {
  const dir = String(runtimeDir || '').replace(/\/+$/, '');
  if (!dir.startsWith('/')) throw new Error('linux runtime directory required');
  return `${dir}/${RUNTIME_ENTRYPOINT_NAME}`;
}

export function runtimeSdkMarkerFor(runtimeDir) {
  const dir = String(runtimeDir || '').replace(/\/+$/, '');
  return `${dir}/node_modules/@cursor/sdk/package.json`;
}

export function runtimePackageManifest() {
  return {
    name: 'vlc-cursor-agent-runtime',
    private: true,
    type: 'module',
    version: '1.0.0',
    description: 'Linux-native Cursor agent runtime for Vision Landing Console development tasks',
    dependencies: { '@cursor/sdk': CURSOR_SDK_PINNED_VERSION },
  };
}

/**
 * Validates a health report emitted by the Linux entrypoint. Returns a public
 * reason string (never a secret, never a host path) when the runtime is not
 * usable.
 */
export function evaluateRuntimeHealth(report, { runtimeDir } = {}) {
  if (!report || typeof report !== 'object') {
    return { ok: false, reason: 'WSL runtime did not report health' };
  }
  if (report.ok !== true) {
    return { ok: false, reason: String(report.reason || 'WSL runtime is not ready') };
  }
  const nodeMajor = Number.parseInt(String(report.node || '').split('.')[0], 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < RUNTIME_MIN_NODE_MAJOR) {
    return { ok: false, reason: `Linux Node ${RUNTIME_MIN_NODE_MAJOR}+ is required in WSL` };
  }
  if (String(report.sdkVersion || '') !== CURSOR_SDK_PINNED_VERSION) {
    return { ok: false, reason: `Linux @cursor/sdk ${CURSOR_SDK_PINNED_VERSION} is required in the WSL runtime` };
  }
  if (report.platformPackagePresent !== true) {
    return { ok: false, reason: `Linux platform package ${CURSOR_SDK_LINUX_PLATFORM_PACKAGE} is missing` };
  }
  if (report.sandboxEnabled !== true) {
    return { ok: false, reason: 'WSL runtime did not confirm sandbox policy' };
  }
  const expectedPrefix = runtimeDir ? `${String(runtimeDir).replace(/\/+$/, '')}/` : null;
  if (expectedPrefix && !String(report.sdkPath || '').startsWith(expectedPrefix)) {
    return { ok: false, reason: 'WSL runtime resolved the SDK outside its Linux prefix' };
  }
  return { ok: true, reason: null };
}

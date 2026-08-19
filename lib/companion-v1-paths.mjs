/**
 * Companion API v1 contract (Jetson is source of truth).
 * Console Node proxies these; the browser never calls the Jetson.
 *
 * Lanes:
 *   NEW           — /api/jetson/v1/*  (this file)
 *   LEGACY        — /api/jetson/status|heartbeat|install|pull-logs|companion-script|releases
 *   TRANSITIONAL  — in-memory jetsonState/visionState/slamState + SSE overlay
 */

export const COMPANION_API_VERSION = 'v1';

/** Paths on the Jetson Companion process. */
export const COMPANION_V1_PATHS = Object.freeze({
  health: '/api/v1/health',
  version: '/api/v1/version',
  status: '/api/v1/status',
  statusSystem: '/api/v1/status/system',
  statusFc: '/api/v1/status/fc',
  statusMavlink: '/api/v1/status/mavlink',
  statusChannels: '/api/v1/status/channels',
  statusVision: '/api/v1/status/vision',
  visionResult: '/api/v1/vision/result',
  statusNavigation: '/api/v1/status/navigation',
  navigationEstimate: '/api/v1/navigation/estimate',
  statusLanding: '/api/v1/status/landing',
  statusVideo: '/api/v1/status/video',
  diagnostics: '/api/v1/diagnostics',
  maintenance: '/api/v1/maintenance',
  config: '/api/v1/config',
  policy: '/api/v1/policy',
  policyPreview: '/api/v1/policy/preview',
  events: '/api/v1/events',
  ws: '/api/v1/ws',
  configRuntime: '/api/v1/config/runtime',
});

/** Browser-facing prefix on the console (localhost:4010). */
export const COMPANION_PROXY_PREFIX = '/api/jetson/v1';

export const COMPANION_READ_METHODS = Object.freeze([
  'getHealth',
  'getVersion',
  'getStatus',
  'getStatusSystem',
  'getStatusFc',
  'getStatusMavlink',
  'getStatusChannels',
  'getStatusVision',
  'getVisionResult',
  'getStatusNavigation',
  'getNavigationEstimate',
  'getStatusLanding',
  'getStatusVideo',
  'getDiagnostics',
  'getMaintenance',
  'getConfig',
  'getPolicy',
  'getPolicyPreview',
]);

export const COMPANION_WRITE_METHODS = Object.freeze(['patchConfigRuntime', 'putPolicy']);

/** v1 does not expose these. Do not add client methods for them. */
export const COMPANION_V1_FORBIDDEN = Object.freeze([
  'ARM',
  'DISARM',
  'SET_MODE',
  'LAND',
  'COMMAND_LONG',
  'UART',
  'systemd',
  'GStreamer',
  'policy-apply',
  'policy-restart',
]);

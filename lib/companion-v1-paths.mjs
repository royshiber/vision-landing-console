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
  networkUplinks: '/api/v1/network/uplinks',
  statusMavlink: '/api/v1/status/mavlink',
  statusChannels: '/api/v1/status/channels',
  statusVision: '/api/v1/status/vision',
  statusCameras: '/api/v1/status/cameras',
  statusGimbal: '/api/v1/status/gimbal',
  cameraFrameCam0: '/api/v1/cameras/cam0/frame',
  cameraFrameCam1: '/api/v1/cameras/cam1/frame',
  cameraFrameCam2: '/api/v1/cameras/cam2/frame',
  cameraFrameCam3: '/api/v1/cameras/cam3/frame',
  cam0Status: '/api/v1/cam0/status',
  cam0Health: '/api/v1/cam0/health',
  cam0Settings: '/api/v1/cam0/settings',
  cam0Detections: '/api/v1/cam0/detections',
  cam0Modules: '/api/v1/cam0/modules',
  cam0Calibration: '/api/v1/cam0/calibration',
  cam0CalibrationCapture: '/api/v1/cam0/calibration/capture',
  cam0CalibrationSolve: '/api/v1/cam0/calibration/solve',
  cam0RecordStart: '/api/v1/cam0/record/start',
  cam0RecordStop: '/api/v1/cam0/record/stop',
  cam0Recordings: '/api/v1/cam0/recordings',
  cam0Snapshot: '/api/v1/cam0/snapshot.png',
  cam0Stream: '/api/v1/cam0/stream.mjpg',
  gimbalRate: '/api/v1/gimbal/rate',
  gimbalAngle: '/api/v1/gimbal/angle',
  gimbalCenter: '/api/v1/gimbal/center',
  gimbalZoom: '/api/v1/gimbal/zoom',
  gimbalMode: '/api/v1/gimbal/mode',
  gimbalPhoto: '/api/v1/gimbal/photo',
  gimbalRecord: '/api/v1/gimbal/record',
  visionResult: '/api/v1/vision/result',
  statusNavigation: '/api/v1/status/navigation',
  statusOpticalNav: '/api/v1/status/optical-nav',
  navigationEstimate: '/api/v1/navigation/estimate',
  statusLanding: '/api/v1/status/landing',
  statusVideo: '/api/v1/status/video',
  statusModem: '/api/v1/status/modem',
  diagnostics: '/api/v1/diagnostics',
  maintenance: '/api/v1/maintenance',
  maintenanceReleases: '/api/v1/maintenance/releases',
  maintenanceBackups: '/api/v1/maintenance/backups',
  maintenanceAudit: '/api/v1/maintenance/audit',
  maintenanceBackup: '/api/v1/maintenance/backup',
  maintenanceDeploy: '/api/v1/maintenance/deploy',
  maintenanceRollback: '/api/v1/maintenance/rollback',
  config: '/api/v1/config',
  policy: '/api/v1/policy',
  policyPreview: '/api/v1/policy/preview',
  events: '/api/v1/events',
  ws: '/api/v1/ws',
  configRuntime: '/api/v1/config/runtime',
});

/** Browser-facing prefix on the console (localhost:4010). */
export const COMPANION_PROXY_PREFIX = '/api/jetson/v1';

/** Data-driven camera slots. cam0 is the OV9281. cam3 is the gimbal RTSP slot. */
export const COMPANION_CAMERA_IDS = Object.freeze(['cam0', 'cam1', 'cam2', 'cam3']);

export function cameraFramePath(camId) {
  const key = String(camId || '').trim().toLowerCase();
  return `/api/v1/cameras/${key}/frame`;
}

export const GIMBAL_CONTROL_DISABLED_HE = 'שליטת גימבל כבויה. לא נשלחה פקודה.';

export const COMPANION_READ_METHODS = Object.freeze([
  'getHealth',
  'getVersion',
  'getStatus',
  'getStatusSystem',
  'getStatusFc',
  'getNetworkUplinks',
  'getStatusMavlink',
  'getStatusChannels',
  'getStatusVision',
  'getStatusCameras',
  'getStatusGimbal',
  'getCameraFrame',
  'getCam0Status',
  'getCam0Health',
  'getCam0Settings',
  'getCam0Detections',
  'getCam0Modules',
  'getCam0Calibration',
  'getCam0Recordings',
  'getCam0Recording',
  'getCam0RecordingFrame',
  'getVisionResult',
  'getStatusNavigation',
  'getStatusOpticalNav',
  'getNavigationEstimate',
  'getStatusLanding',
  'getStatusVideo',
  'getDiagnostics',
  'getMaintenance',
  'getMaintenanceReleases',
  'getMaintenanceRelease',
  'getMaintenanceBackups',
  'getMaintenanceAudit',
  'getConfig',
  'getPolicy',
  'getPolicyPreview',
]);

export const COMPANION_WRITE_METHODS = Object.freeze([
  'patchConfigRuntime',
  'putPolicy',
  'postGimbalRate',
  'postGimbalAngle',
  'postGimbalCenter',
  'postGimbalZoom',
  'postGimbalMode',
  'postGimbalPhoto',
  'postGimbalRecord',
  'postMaintenanceBackup',
  'postMaintenanceDeploy',
  'postMaintenanceRollback',
  'setNetworkUplink',
  'postCam0Settings',
  'postCam0Module',
  'postCam0RecordStart',
  'postCam0RecordStop',
  'postCam0CalibrationCapture',
  'postCam0CalibrationSolve',
]);

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
  'config-apply',
  'config-restart',
]);

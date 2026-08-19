# AIRVIX Companion B2 UI - 1.02.238

## Scope

This note documents only the Companion B2 read-only UI foundation.

## Telemetry

- The telemetry screen retains its existing dashboard and adds Dashboard and Companion subtabs.
- The dashboard summary shows Companion API state, version, FC connectivity, vision health, landing detection, and video availability.
- Missing measurements render as an em dash and never as a synthetic zero.
- Mock mode exposes Healthy, Disconnected, and Degraded scenario buttons.

## Companion panel

- Cards present system, FC, MAVLink, channels, vision, navigation, landing, video, policy preview, configuration tiers, and diagnostics.
- Landing and navigation values are explicitly display-only.
- Video is a status placeholder and does not carry a media stream.
- Configuration and policy are rendered as read-only values.

## Maintenance (read-only + release management)

- Tab loads GET /api/v1/maintenance via console proxy /api/jetson/v1/maintenance.
- Groups: software (Git), system metrics, companion API state, diagnostics.recent (health field).
- Release management (C8.2): inventory, backups, deploy, rollback, audit via maintenance/* endpoints.
- Deploy POST body contains only release_id - no path, URL, or shell fields.
- C8.3.4 uses authoritative running_process_changed and running_version from server to decide deploy success and visible running version.
- Console-local fields: UI version from meta tag, companion mode hint from SSE.
- No systemd, service restart, or shell controls.

## Visual rules

- Existing color, typography, spacing, card, and tab tokens are reused.
- Companion additions use compact responsive grids and preserve the existing dashboard hierarchy.

## Design change log

- 1.02.238 - C8.3.4 deploy/rollback wired to real runtime outcome (SUCCEEDED/FAILED/ROLLED_BACK), with operation lock and audit/release refresh.
- 1.02.236 - C8.2 release management UI: inventory, backup, deploy, rollback, audit; mock fixtures; restart-required messaging.
- 1.02.234 - C8.1 read-only maintenance UI, API proxy, mock, OpenAPI sync, health schema alignment.
- 1.02.232 - Added the narrow Companion B2 read-only dashboard, detail panel, mock selector, and maintenance placeholder.

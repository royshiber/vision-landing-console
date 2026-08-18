# AIRVIX Companion B2 UI — 1.02.232

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

## Maintenance placeholder

- The maintenance screen shows versions and mode only.
- It contains no restart, deployment, shell, networking, or service controls.

## Visual rules

- Existing color, typography, spacing, card, and tab tokens are reused.
- Companion additions use compact responsive grids and preserve the existing dashboard hierarchy.

## Design change log

- 1.02.232 — Added the narrow Companion B2 read-only dashboard, detail panel, mock selector, and maintenance placeholder.

# Companion API v1 — console snapshot (not a second source of truth)

**Source of truth (authoritative):** Jetson Companion repository.

| Field | Value |
|-------|--------|
| Source repository | Jetson Companion (`/home/royshiber/jetson`) |
| Source path | `/home/royshiber/jetson/architecture/openapi/companion-api-v1.yaml` |
| Source commit | `dffecbfc1bc3e425035df3a09f416209d0b79f0e` |
| Source SHA256 | `df1cb9d356d584c43e3de2a76d1f76456afaf5d37a8db106944246141136d101` |
| Synchronization date | 2026-08-19 |

This YAML is a **verbatim copy**. Do not edit it to “improve” the aircraft API.

OpenAPI `servers.url` already includes `/api/v1`. Path keys in the YAML are `/health`, `/status`, …
Console Node joins `JETSON_COMPANION_BASE_URL` with those `/api/v1/...` paths.
If the env base already ends in `/api/v1`, the prefix is not duplicated.

**C8.1.7 sync:** includes `GET /maintenance` (`MaintenanceStatus`, `MaintenanceSoftware`, `MaintenanceCompanion`, `MaintenanceDiagnostics`).

# Companion API v1 — console snapshot (not a second source of truth)

**Source of truth (authoritative):** Jetson Companion repository.

| Field | Value |
|-------|--------|
| Source repository | Jetson Companion |
| Source path | `/home/royshiber/jetson/architecture/openapi/companion-api-v1.yaml` |
| Source commit | `fb489e86429b518b934f74abbc804ad21b266788` |
| Source SHA256 | `927ad90467123cf6dd47d11b015be1131910051a322347e49fa0d226aad310b3` |
| Synchronization date | 2026-08-18 |

This YAML is a **verbatim copy**. Do not edit it to “improve” the aircraft API.

OpenAPI `servers.url` already includes `/api/v1`. Path keys in the YAML are `/health`, `/status`, …
Console Node joins `JETSON_COMPANION_BASE_URL` with those `/api/v1/...` paths.
If the env base already ends in `/api/v1`, the prefix is not duplicated.

# Companion API v1 — console snapshot (not a second source of truth)

**Source of truth (authoritative):** the Jetson Companion repository files:

- `architecture/API_CONTRACT.md`
- `architecture/openapi/companion-api-v1.yaml`

This directory is a **read-only consumption snapshot** for Vision Landing Console.
Do not edit the schema here to “improve” the aircraft API.
When the Jetson file changes, replace `openapi/companion-api-v1.yaml` with a verbatim copy and keep this provenance note.

**Snapshot date:** 2026-08-18

**Why a snapshot exists:** this Cloud workspace cannot read the Jetson git tree.
The YAML encodes the **approved v1 path list** plus the **wire field names** the console now consumes.
Python/FastAPI-style `snake_case` is the contract naming. Console camelCase names are **transitional aliases only** (`x-console-aliases` in the YAML).

**Console-only (not aircraft contract):** `DISABLED`, `NOT_PRESENT`, SSE `jetson` / `slam` overlay fields.

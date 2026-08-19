# AIRVIX Companion B2 UI - 1.02.244

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

## Development tasks (C9.1)

- New DEVELOPMENT tab provides local task-management workflow without code execution.
- Task model includes status, priority, target area, metadata placeholders, tests/release/deploy placeholders, and audit history.
- Backend validates controlled status transitions and rejects unsafe arbitrary fields.
- Persistence is local JSON with atomic writes under var/development/tasks.json.

## Development agent integration (C9.2)

- Development task details now include a controlled coding-agent session model: provider, session_id, state, branch, worktree, timestamps, last message, progress, and error.
- Agent lifecycle is isolated behind `CodingAgentProvider`; no direct dependency on Cursor internals is required by the UI/API layer.
- Mock provider is deterministic and supports healthy, degraded, and disconnected scenarios without modifying source code.
- Agent actions are explicit and confirmed by the operator: start development and cancel agent.
- Task transitions are controlled: successful agent completion moves task to TESTING and sets release.state to READY_TO_BUILD; failed agent sets task to FAILED; cancelled agent sets task to CANCELLED.
- No automatic test execution, release creation, or deployment is performed in this phase.

## Worktree and controlled testing (C9.3)

- Added `DevelopmentWorktreeManager` for deterministic task branches and isolated `.worktrees/<task-id-slug>` checkouts under the current repository only.
- Worktree APIs are controlled and internally generated from task id; browser input cannot provide git args, shell commands, branch names, or filesystem paths.
- Added controlled testing profiles behind `TestingProvider`: `CONSOLE_FULL`, `COMPANION_CONTRACT`, `MAINTENANCE`, `DEVELOPMENT`.
- Tests run in task worktrees, not in master checkout; lifecycle states are tracked as `NOT_STARTED/QUEUED/RUNNING/PASSED/FAILED/CANCELLED`.
- Test output is bounded and stored by log reference under `var/development/test-logs` rather than embedding full output in task JSON.
- Passing tests moves task to `WAITING_FOR_REVIEW`; failing tests move task to `FAILED`; no automatic release/deploy is triggered.

## Real-provider readiness (C9.4)

- Agent provider contract now supports worktree-bound sessions (`createSession(task, worktree)`) and returns bounded metadata only.
- Agent start is rejected unless the task already has an approved isolated worktree; provider start is bound to that specific task branch and worktree.
- Agent success no longer auto-enters `TESTING`; testing remains an explicit operator action through approved test profiles.
- Cancellation remains provider-mediated only; unsupported cancel returns `NOT_SUPPORTED` without browser-level process control.
- No real Cursor provider was introduced; unavailable mode remains the real-mode fallback when no stable provider mechanism is detected.

## Development to release bridge (C9.5)

- Added explicit release approvals from `WAITING_FOR_REVIEW` to `READY_FOR_RELEASE` with strict precondition checks.
- Added deterministic release builder from the tested worktree commit with SHA256 and artifact metadata.
- Release creation is explicit and controlled; it refuses dirty worktrees, unsafe branches, missing passed tests, and non-succeeded agent states.
- Release deploy from task detail now calls existing maintenance deploy pipeline via server-side companion client integration.
- Deploy outcomes (`SUCCEEDED` / `FAILED` / `ROLLED_BACK`) are mapped back into task deployment metadata and task status without client-side assumptions.

## Visual rules

- Existing color, typography, spacing, card, and tab tokens are reused.
- Companion additions use compact responsive grids and preserve the existing dashboard hierarchy.

## Design change log

- 1.02.244 - C9.5 development-to-release workflow: approval gate, deterministic release build metadata, and deploy integration mapped into task state/audit.
- 1.02.243 - C9.4 provider-readiness hardening: strict worktree binding, upgraded provider contract, explicit testing handoff, bounded agent metadata, and NOT_SUPPORTED cancel behavior.
- 1.02.242 - C9.3 real worktrees and controlled testing: isolated git worktrees, approved test profiles, run/status/cancel APIs, and audit events.
- 1.02.241 - C9.2 controlled coding-agent integration: provider abstraction, deterministic mock lifecycle, isolated branch/worktree metadata, start/cancel/status APIs, and task/audit transitions.
- 1.02.240 - C9.1 development task foundation: local model, routes, filters, detail, audit, and persistence.
- 1.02.239 - C8.3.4 deploy/rollback wired to real runtime outcome (SUCCEEDED/FAILED/ROLLED_BACK), with operation lock and audit/release refresh.
- 1.02.236 - C8.2 release management UI: inventory, backup, deploy, rollback, audit; mock fixtures; restart-required messaging.
- 1.02.234 - C8.1 read-only maintenance UI, API proxy, mock, OpenAPI sync, health schema alignment.
- 1.02.232 - Added the narrow Companion B2 read-only dashboard, detail panel, mock selector, and maintenance placeholder.

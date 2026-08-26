# Product Execution Map

Living PM roadmap for Vision Landing Console. Not a frozen checklist. Not the GitHub backlog.

**Owner:** King (PM + Technical Lead + Project Manager). Cloud Agents implement; they do not own the plan.

**Language:** English. This file is the execution map. Product UI remains Hebrew RTL.

**Do not invent** `STATUS.md`. Constitution / work-rules live in `AGENTS.md` (draft PR #6 — do not edit that file from this map).

---

## Destination

Self-evolving console. The agent is part of the product, not a sidecar IDE.

Locked loop:

```
User
  → Product UI (Assist, natural language)
  → Agent API
  → Cursor Agent
  → isolated branch
  → verify
  → result back to Product UI
```

Also the product, not optional extras:

- Full flight ops
- Full params
- Full Jetson UI control
- Full auto landing

**30-day bar:** operate the console without fighting the UI. Agent runs inside the product.

Measure by **capabilities closed** and **distance to vision**, not PR count.

---

## How to update

After every meaningful **VERIFY**:

1. **Inspect** master, open drafts, open issues, and what actually shipped in the product.
2. **Re-plan** this file: rewrite the dated audit snapshot. Do not append forever.
3. **Pick next** using GAP > BUG > IMPROVEMENT. One next, in order.
4. **Execute** on an isolated branch. Stay draft until a Human Gate says otherwise.

Rules:

- King rewrites the snapshot after VERIFY. Old snapshot dates may stay as a one-line pointer; the current snapshot is the plan.
- Discover GAPS. Do not only consume Issues.
- Do not ask Roy what to work on next unless vision, safety, scope, or two materially different product choices require him.
- WAITING FOR ROY blocks only that decision.
- Human Gates stay Human Gates even if a GAP is large.

---

## Classification

Use this order when picking work:

| Class | Meaning | Default |
|---|---|---|
| **GAP** | Capability the destination requires and the product does not yet have | Highest. Close these. |
| **BUG** | Something that should already work is wrong | After GAPS that block the destination, unless it is blocking VERIFY |
| **IMPROVEMENT** | Polish, copy, chrome, changelog | Last, while major GAPS remain |

---

## Human Gates

Do not implement without explicit Roy **GO**:

- Companion apply / restart (live Jetson, systemd, GStreamer) — Issue #28
- ARM / DISARM / LAND / SET_MODE / live FC write / auto-landing — Issue #29
- Merge to `master`
- Secrets / deploy

Also locked without GO:

- Mock GPS (HUD GPS–Vision delta stays `-- m` until real GPS)
- Fake agent runs when the provider is `UNAVAILABLE`

---

## Milestones

| ID | Capability | Gate |
|---|---|---|
| **A** | In-product isolated agent loop: Assist Confirm starts a Cursor Agent on an isolated branch | **LANDED** on master 2026-08-25 via PR #33 merge `51d2ef41`. Issue #31 done on master. |
| **B** | Results visible in Assist (status, then live progress, then outcome) | **LANDED** with A. Operator can connect the coding agent from Assist (PR #34). UNAVAILABLE stays honest for empty/invalid key. |
| **C** | Companion apply after GO | Human Gate (#28). No GO. |
| **D** | Flight ops + auto-land after GO | Human Gate (#29). No GO. |

Params vs live FC: persist leftover is draft PR #30 (do not merge). Write-to-vehicle is a Human Gate.

---

## Near-term (do, in this order)

1. Assist Confirm starts an isolated Cursor Agent and returns Hebrew status/result. **LANDED on master** via PR #33 merge `51d2ef41`. Issue #31 done on master; GitHub close blocked (`Resource not accessible by integration`).
2. Operator can connect the coding agent from Assist. **LANDED on master** via PR #34. This closed the old “agent READY” hole. Empty/invalid key stays UNAVAILABLE. Do not keep “make agent READY” as next executable work. Do not fake READY.
3. Human Gates stay WAITING FOR ROY: companion apply/restart (#28), live vehicle / auto-landing (#29), merge / secrets / deploy.
4. Latest product tree (302+) is parked on Roy’s machine. GitHub public `master` max real `APP_VERSION` is `1.02.255`. Do not treat 255 as the current shipping UI. Do not polish 255 chrome as if it were the current product.
5. Keep leftover drafts draft. Do **not** merge #4, #6, #15, #30, #32, #37, or #38. Keep constitution PR #6 updated; merge is a Human Gate.
6. After this map rewrite, **stop creating 255 polish PRs**. Do not ask Roy what to work on next.

---

## Audit snapshot — 2026-08-26

**Master:** `1.02.255` @ `eea7ea8` (PR #36 merge). Do not bump.  
**Prior pointer:** 2026-08-25 post PR #33 snapshot at `c850e38` is superseded. It was wrong about remaining work (still listed “make agent READY”).  
**This file:** living plan as of this VERIFY. Draft PR #32. Do not merge. King (PM) independently VERIFIES.

### Landed on master after the 2026-08-25 snapshot (true)

- PR #33 Assist confirm → isolated agent → result in Assist (`51d2ef41`). Issue #31 done on master; GitHub close blocked (`Resource not accessible by integration`).
- PR #34 Assist connect-from-screen: operator can connect the coding agent from Assist; SQLite `codingAgentConnection`; `GET /api/assist/agent` masks key last-4. Empty/invalid key stays UNAVAILABLE. This **lands the old “agent READY” hole**. Do not keep “make agent READY” as next executable work.
- PR #35 Hebrew Assist development phrasing (Unicode letter bounds). Questions stay questions.
- PR #36 Hebrew Assist answers for QUESTION / UI_ACTION / NOTE / OBSERVATION / UNRESOLVED / prohibited. Coding-agent `last_message` stays English by design.

### Already on master (keep)

- Connections persist in SQLite (PR #5).
- Companion real mode requires **BOTH** `COMPANION_MODE=real` **and** `JETSON_COMPANION_BASE_URL` (PR #20). A URL alone must never enable real.
- Companion RUNTIME config is save-not-apply (PR #25). Persistent Hebrew note: saved, not applied.
- Companion policy editor unwraps the GET envelope so channels hydrate (PR #24).
- HUD GPS–Vision delta stays `-- m` until real GPS. Do not invent mock GPS (PR #22).
- Vision config + `arduTargetParams` persist via SQLite `server_config` on `POST /api/vision/config` (PR #18).
- Assist Confirm / Cancel labels are Hebrew (PR #9). Issues #8 / #10 are done on master — close later.
- Development Tasks empty-state copy is Hebrew (PR #13).

### Assist / agent (loop + connect landed)

On master today (PR #33 + PR #34):

- DEVELOPMENT / REQUEST Confirm creates the task, creates the isolated worktree/branch, and starts the agent **when the provider is READY**.
- Assist returns Hebrew status and polls `GET /api/assist/tasks/:id` (RUNNING → result). Progress, PR URL, and last message surface when the provider exposes them.
- Operator can connect the coding agent from Assist. Connection is stored in SQLite `codingAgentConnection`. `GET /api/assist/agent` masks the key to last-4.
- If the key is empty or invalid, the provider stays **UNAVAILABLE**. The task still exists, `agent_started` is false, and Assist shows the Hebrew unavailable reason. It does not pretend the agent ran.
- Do not fake READY. Secrets remain a Human Gate.

Intended architecture is the Destination loop above. Safety still required: isolated `development/tasks/` (or equivalent) branch, no merge to master, no FC / Jetson / apply / restart / flight commands, explicit Confirm in Assist.

### Remaining hole (params)

`POST /api/param-center/param-set` is still RAM-only on master. Draft PR #30 persists those RAM updates through the same `server_config` snapshot. VERIFY passed earlier; **stay draft. Do not merge #30.** Out of scope for #30: live FC `PARAM_SET` as a product capability (Human Gate).

### Open drafts (stay draft — do not merge)

| PR | Topic | This map |
|---|---|---|
| [#4](https://github.com/royshiber/vision-landing-console/pull/4) | PM orchestrator smoke | Skip. Do not merge. |
| [#6](https://github.com/royshiber/vision-landing-console/pull/6) | `AGENTS.md` constitution | Keep updated; merge is Human Gate (Roy). Do not merge. |
| [#15](https://github.com/royshiber/vision-landing-console/pull/15) | Changelog polish | Skip. Do not merge. |
| [#30](https://github.com/royshiber/vision-landing-console/pull/30) | param-set persist through SQLite | VERIFY passed earlier. Stay draft. Do not merge. |
| [#32](https://github.com/royshiber/vision-landing-console/pull/32) | This living map | Stay draft. Do not merge. |
| [#37](https://github.com/royshiber/vision-landing-console/pull/37) | Empty Maintenance confirm modal (CSS `[hidden]` + Hebrew deploy/rollback copy) | Independent VERIFY passed 2026-08-26. Stay draft. Do not merge. |
| [#38](https://github.com/royshiber/vision-landing-console/pull/38) | Hebrew Development Tasks chrome (`DEVELOPMENT` → `פיתוח`) | Independent VERIFY passed 2026-08-26. Stay draft. Do not merge. Leftover English lives in `public/app.js` (`failed to load tasks`, filter `ALL`, `window.confirm`) deferred because #37 owns `app.js`. |

Do not merge leftover drafts #4 #6 #15 #30 #32 #37 #38.

### Open issues

| Issue | Topic | Class |
|---|---|---|
| [#7](https://github.com/royshiber/vision-landing-console/issues/7) | Constitution in `AGENTS.md` | Implemented in draft #6; leave open until Roy merges |
| [#8](https://github.com/royshiber/vision-landing-console/issues/8) / [#10](https://github.com/royshiber/vision-landing-console/issues/10) | Assist Confirm/Cancel English | Done on master (PR #9). Close later. |
| [#12](https://github.com/royshiber/vision-landing-console/issues/12) / [#16](https://github.com/royshiber/vision-landing-console/issues/16) | Changelog dump rows | IMPROVEMENT. Skip while GAPS remain. |
| [#14](https://github.com/royshiber/vision-landing-console/issues/14) | Remaining Development English chrome | IMPROVEMENT. Draft #38 covers Tasks chrome. Remaining JS English waits for #37 file overlap to clear. Skip. |
| [#27](https://github.com/royshiber/vision-landing-console/issues/27) | Params persist | Mostly landed in #18. Leftover is param-set (draft #30; do not merge). |
| [#28](https://github.com/royshiber/vision-landing-console/issues/28) | Companion apply/restart | GAP + Human Gate. Highest remaining destination value. No GO. |
| [#29](https://github.com/royshiber/vision-landing-console/issues/29) | Live vehicle + auto-landing | GAP + Human Gate. Next remaining value. No GO. |
| [#31](https://github.com/royshiber/vision-landing-console/issues/31) | In-product Cursor Agent loop | **Done on master.** PR #33 merged `51d2ef41` 2026-08-25. GitHub close blocked (`Resource not accessible by integration`). |

### Version hunt (parked)

Roy 2026-08-26: park searching the local `VisionLandingConsole` tree for versions past 302. GitHub public `master` max real `APP_VERSION` is `1.02.255`. Do not treat 255 as the current shipping UI. Functional / safety / loop work on GitHub master is OK until 302 is found. Do not polish 255 chrome as if it were the current product.

### Ranked GAPS (this snapshot)

1. **Companion apply/restart** — Human Gate. Issue #28. Milestone C. Highest remaining destination value. No GO.
2. **Live vehicle + auto landing** — Human Gate. Issue #29. Milestone D. No GO.
3. **Latest product tree (302+)** — parked on Roy’s machine. Not executable from GitHub 255.
4. **Full params vs live FC** — persist leftover is draft #30 (do not merge); write-to-vehicle is Human Gate.

### Explicitly not next

Do not spend cycles on changelog #15, smoke #4, more 255 chrome, version bump, Jetson/FC, or merging drafts. Issue #14 leftover chrome is covered by draft #38; remaining JS English waits for #37 file overlap to clear.

### Next pick (this snapshot)

Human Gates stay WAITING FOR ROY. 302 hunt is parked. Independent executable work on GitHub 255 that is not chrome / Human Gate is thin. After this map rewrite, stop creating 255 polish PRs. Do not ask Roy what to work on next. Do not merge this map.

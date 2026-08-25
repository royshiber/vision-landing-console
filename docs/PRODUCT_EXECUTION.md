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

- Companion apply / restart (live Jetson, systemd, GStreamer)
- ARM / DISARM / LAND / SET_MODE / live FC write
- Merge to `master`
- Secrets / deploy

Also locked without GO:

- Mock GPS (HUD GPS–Vision delta stays `-- m` until real GPS)
- Fake agent runs when the provider is `UNAVAILABLE`

---

## Milestones

| ID | Capability | Gate |
|---|---|---|
| **A** | In-product isolated agent loop: Assist Confirm starts a Cursor Agent on an isolated branch | **LANDED** on master 2026-08-25 via PR #33 merge `51d2ef41`. Issue #31 done. |
| **B** | Results visible in Assist (status, then live progress, then outcome) | **LANDED** with A: Hebrew status + `GET /api/assist/tasks/:id` poll RUNNING → result. UNAVAILABLE is honest (no fake run). |
| **C** | Companion apply after GO | Human Gate (#28) |
| **D** | Flight ops + auto-land after GO | Human Gate (#29) |

Params vs live FC: console persistence is a GAP (safe). Write-to-vehicle is a Human Gate.

---

## Near-term (do, in this order)

1. Assist Confirm starts an isolated Cursor Agent and returns Hebrew status/result. **LANDED on master** via PR #33 merge `51d2ef41` 2026-08-25. Issue #31 done.
2. Highest remaining GAPS (this snapshot): companion apply/restart (Human Gate #28), live vehicle/auto-landing (Human Gate #29), and making the in-product agent actually **READY** when `CURSOR_API_KEY` / `DEVELOPMENT_AGENT_PROVIDER` are unset. UNAVAILABLE is honest, but the loop cannot run for Roy until the console has a working agent.
3. Finish / VERIFY param-set persist PR #30. Retarget or close Issue #27 after VERIFY. **Do not merge #30.**
4. Keep constitution PR #6 updated. **Do not merge #6** without Roy.
5. Do **not** merge #32 (this map), #15, or #4. Do **not** spend cycles on changelog PR #15, smoke PR #4, remaining Development English chrome, version bump, or Jetson/FC while these GAPS remain.

---

## Audit snapshot — 2026-08-25 (post PR #33 VERIFY)

**Master:** `1.02.255` @ `51d2ef41` (PR #33 merge: Assist confirm starts isolated coding agent and returns result to UI).  
**Prior pointer:** same-day snapshot at `b4b094a` (PR #18 line) is superseded. Rewrite after the next meaningful VERIFY.  
**This file:** living plan as of this VERIFY. Draft PR #32. Do not merge.

### On master (true)

- Connections persist in SQLite (PR #5).
- Companion real mode requires **BOTH** `COMPANION_MODE=real` **and** `JETSON_COMPANION_BASE_URL` (PR #20). A URL alone must never enable real.
- Companion RUNTIME config is save-not-apply (PR #25). Persistent Hebrew note: saved, not applied.
- Companion policy editor unwraps the GET envelope so channels hydrate (PR #24).
- HUD GPS–Vision delta stays `-- m` until real GPS. Do not invent mock GPS (PR #22).
- Vision config + `arduTargetParams` persist via SQLite `server_config` on `POST /api/vision/config` (PR #18).
- Assist Confirm / Cancel labels are Hebrew (PR #9). Issues #8 / #10 are done on master — close later.
- Development Tasks empty-state copy is Hebrew (PR #13). Issue #14 leftover is remaining Development English chrome (polish).
- Assist Confirm for DEVELOPMENT/REQUEST now composes: create task → isolated `development/tasks/` worktree → start coding agent when provider is READY → Hebrew status back to Assist, with poll on `GET /api/assist/tasks/:id` (PR #33). `CURSOR_AGENT_START` stays in `ASSIST_PROHIBITED_ACTIONS` as a proposed action; the loop is server-side composition after confirmed `CREATE_DEVELOPMENT_TASK`. No in-app merge to master, no deploy, no Jetson/FC/apply/restart.

### Remaining hole (params)

`POST /api/param-center/param-set` is still RAM-only. Draft PR #30 persists those RAM updates through the same `server_config` snapshot. Out of scope for #30: live FC `PARAM_SET` as a product capability (Human Gate). **Do not merge #30.**

### Assist / agent (loop landed; not READY for Roy)

On master today (PR #33):

- DEVELOPMENT / REQUEST Confirm creates the task, creates the isolated worktree/branch, and starts the agent **when the provider is READY**.
- Assist returns Hebrew status and polls `GET /api/assist/tasks/:id` (RUNNING → result). Progress, PR URL, and last message surface when the provider exposes them.
- If the provider is **UNAVAILABLE**, the task still exists, `agent_started` is false, and Assist shows the Hebrew unavailable reason. It does not pretend the agent ran.
- Coding agent API exists (`cursor-sdk` + WSL on Windows). Default is still `UNAVAILABLE` unless `DEVELOPMENT_AGENT_PROVIDER=cursor-sdk` **and** `CURSOR_API_KEY` are set.
- **Remaining GAP:** UNAVAILABLE is honest, but the destination loop cannot run for Roy until the console has a working agent. Do not fake READY. Secrets remain a Human Gate.

Intended architecture is the Destination loop above. Safety still required: isolated `development/tasks/` (or equivalent) branch, no merge to master, no FC / Jetson / apply / restart / flight commands, explicit Confirm in Assist.

### Open drafts (stay draft — do not merge)

| PR | Topic | This map |
|---|---|---|
| [#4](https://github.com/royshiber/vision-landing-console/pull/4) | PM orchestrator smoke | Skip. Do not merge. |
| [#6](https://github.com/royshiber/vision-landing-console/pull/6) | `AGENTS.md` constitution | Keep updated; merge is Human Gate (Roy). Do not merge. |
| [#15](https://github.com/royshiber/vision-landing-console/pull/15) | Changelog polish | Skip. Do not merge. |
| [#30](https://github.com/royshiber/vision-landing-console/pull/30) | param-set persist | Finish / VERIFY; then retarget or close #27. Do not merge. |
| [#32](https://github.com/royshiber/vision-landing-console/pull/32) | This living map | Stay draft. Do not merge. |

### Open issues

| Issue | Topic | Class |
|---|---|---|
| [#7](https://github.com/royshiber/vision-landing-console/issues/7) | Constitution in `AGENTS.md` | Implemented in draft #6; leave open until Roy merges |
| [#8](https://github.com/royshiber/vision-landing-console/issues/8) / [#10](https://github.com/royshiber/vision-landing-console/issues/10) | Assist Confirm/Cancel English | Done on master (PR #9). Close later. |
| [#12](https://github.com/royshiber/vision-landing-console/issues/12) / [#16](https://github.com/royshiber/vision-landing-console/issues/16) | Changelog dump rows | IMPROVEMENT. Skip while GAPS remain. |
| [#14](https://github.com/royshiber/vision-landing-console/issues/14) | Remaining Development English chrome | IMPROVEMENT / polish. Skip while GAPS remain. |
| [#27](https://github.com/royshiber/vision-landing-console/issues/27) | Params persist | Mostly landed in #18. Leftover is param-set (PR #30). |
| [#28](https://github.com/royshiber/vision-landing-console/issues/28) | Companion apply/restart | GAP + Human Gate. Highest remaining value. No GO. |
| [#29](https://github.com/royshiber/vision-landing-console/issues/29) | Live vehicle + auto-landing | GAP + Human Gate. Next remaining value. No GO. |
| [#31](https://github.com/royshiber/vision-landing-console/issues/31) | In-product Cursor Agent loop | **Done.** PR #33 merged to master `51d2ef41` 2026-08-25. Close. |

### Ranked GAPS (this snapshot)

1. **Companion apply/restart** — Human Gate. Issue #28. Milestone C. Highest remaining value. Do not implement without Roy GO. No Jetson/FC from this map.
2. **Live vehicle + auto landing** — Human Gate. Issue #29. Milestone D. Do not implement without Roy GO.
3. **In-product agent actually READY** — loop (Milestone A/B, Issue #31) is on master, but default `UNAVAILABLE` when `CURSOR_API_KEY` / `DEVELOPMENT_AGENT_PROVIDER` are unset. Honest, yet Roy cannot run the loop until the console has a working agent. Do not fake a run. Secrets / deploy stay a Human Gate.
4. **Full params vs live FC** — persist leftover is PR #30 (do not merge); write-to-vehicle is Human Gate.

### Explicitly not next

Do not merge #32 / #30 / #15 / #6 / #4. Changelog #15, smoke PR #4, Development English chrome, constitution merge, Jetson/FC, version bump from this map.

### Next pick (this snapshot)

Human Gates #28 and #29 stay WAITING FOR ROY. Executable next: make the in-product agent actually READY so Roy can run the landed Assist loop without `CURSOR_API_KEY` / `DEVELOPMENT_AGENT_PROVIDER` unset leaving the product UNAVAILABLE. Do not fake READY. Do not merge this map.

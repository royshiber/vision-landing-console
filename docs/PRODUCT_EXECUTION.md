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
| **A** | In-product isolated agent loop: Assist Confirm starts a Cursor Agent on an isolated branch | Safe to build now (no merge, no FC/Jetson) |
| **B** | Results visible in Assist (status, then live progress, then outcome) | Follows A VERIFY |
| **C** | Companion apply after GO | Human Gate (#28) |
| **D** | Flight ops + auto-land after GO | Human Gate (#29) |

Params vs live FC: console persistence is a GAP (safe). Write-to-vehicle is a Human Gate.

---

## Near-term (do, in this order)

1. Assist Confirm starts an isolated Cursor Agent and returns Hebrew status/result. **IN FLIGHT as of 2026-08-25. No merge.** Tracker: Issue #31.
2. Surface the `UNAVAILABLE` reason in Assist. Never fake a run.
3. Finish / VERIFY param-set persist PR #30. Retarget or close Issue #27 after VERIFY.
4. After loop VERIFY: live agent progress in Assist (Milestone B).
5. Keep constitution PR #6 updated. Do not merge without Roy.
6. Do **not** spend cycles on changelog PR #15, smoke PR #4, or remaining Development English chrome while these GAPS remain.

---

## Audit snapshot — 2026-08-25

**Master:** `1.02.255` @ `b4b094a` (PR #18 merge and later on this line).  
**This file:** living plan as of this date. Rewrite after the next meaningful VERIFY.

### On master (true)

- Connections persist in SQLite (PR #5).
- Companion real mode requires **BOTH** `COMPANION_MODE=real` **and** `JETSON_COMPANION_BASE_URL` (PR #20). A URL alone must never enable real.
- Companion RUNTIME config is save-not-apply (PR #25). Persistent Hebrew note: saved, not applied.
- Companion policy editor unwraps the GET envelope so channels hydrate (PR #24).
- HUD GPS–Vision delta stays `-- m` until real GPS. Do not invent mock GPS (PR #22).
- Vision config + `arduTargetParams` persist via SQLite `server_config` on `POST /api/vision/config` (PR #18).
- Assist Confirm / Cancel labels are Hebrew (PR #9). Issues #8 / #10 are done on master — close later.
- Development Tasks empty-state copy is Hebrew (PR #13). Issue #14 leftover is remaining Development English chrome (polish).

### Remaining hole (params)

`POST /api/param-center/param-set` is still RAM-only. Draft PR #30 persists those RAM updates through the same `server_config` snapshot. Out of scope for #30: live FC `PARAM_SET` as a product capability (Human Gate).

### Assist / agent (the highest safe GAP)

On master today:

- DEVELOPMENT / REQUEST Confirm creates a development **task only**.
- Assist service comment: never start agent / release / deploy from Assist.
- `CURSOR_AGENT_START` is in `ASSIST_PROHIBITED_ACTIONS`. Assist must not propose it.
- `next_step`: agent will not start automatically.
- Operator then leaves Assist for the Development Tasks panel (create worktree, Start development, English chrome).
- Progress, PR, and summary do **not** return to Assist.
- Coding agent API exists (`cursor-sdk` + WSL on Windows). Default is `UNAVAILABLE` unless `DEVELOPMENT_AGENT_PROVIDER=cursor-sdk` **and** `CURSOR_API_KEY` are set.

Intended architecture is the Destination loop above. Safety if implemented: isolated `development/tasks/` (or equivalent) branch, no merge to master, no FC / Jetson / apply / restart / flight commands, explicit Confirm in Assist.

### Open drafts (stay draft)

| PR | Topic | This map |
|---|---|---|
| [#4](https://github.com/royshiber/vision-landing-console/pull/4) | PM orchestrator smoke | Skip |
| [#6](https://github.com/royshiber/vision-landing-console/pull/6) | `AGENTS.md` constitution | Keep updated; merge is Human Gate (Roy) |
| [#15](https://github.com/royshiber/vision-landing-console/pull/15) | Changelog polish | Skip |
| [#30](https://github.com/royshiber/vision-landing-console/pull/30) | param-set persist | Finish / VERIFY; then retarget or close #27 |

### Open issues

| Issue | Topic | Class |
|---|---|---|
| [#7](https://github.com/royshiber/vision-landing-console/issues/7) | Constitution in `AGENTS.md` | Implemented in draft #6; leave open until Roy merges |
| [#8](https://github.com/royshiber/vision-landing-console/issues/8) / [#10](https://github.com/royshiber/vision-landing-console/issues/10) | Assist Confirm/Cancel English | Done on master (PR #9). Close later. |
| [#12](https://github.com/royshiber/vision-landing-console/issues/12) / [#16](https://github.com/royshiber/vision-landing-console/issues/16) | Changelog dump rows | IMPROVEMENT. Skip while GAPS remain. |
| [#14](https://github.com/royshiber/vision-landing-console/issues/14) | Remaining Development English chrome | IMPROVEMENT / polish. Skip while GAPS remain. |
| [#27](https://github.com/royshiber/vision-landing-console/issues/27) | Params persist | Mostly landed in #18. Leftover is param-set (PR #30). |
| [#28](https://github.com/royshiber/vision-landing-console/issues/28) | Companion apply/restart | GAP + Human Gate |
| [#29](https://github.com/royshiber/vision-landing-console/issues/29) | Live vehicle + auto-landing | GAP + Human Gate |
| [#31](https://github.com/royshiber/vision-landing-console/issues/31) | In-product Cursor Agent loop | Highest safe GAP. IN FLIGHT 2026-08-25. No merge. |

### Ranked GAPS (this snapshot)

1. **In-product agent loop** — highest safe. Milestone A → B. Issue #31.
2. **Companion apply/restart** — Human Gate. Issue #28. Milestone C.
3. **Live vehicle + auto landing** — Human Gate. Issue #29. Milestone D.
4. **Full params vs live FC** — persist leftover is PR #30; write-to-vehicle is Human Gate.

### Explicitly not next

Changelog #15, smoke PR #4, Development English chrome, constitution merge, Jetson/FC, version bump from this map.

### Next pick (this snapshot)

Close the Assist → isolated Cursor Agent → Hebrew result loop (Issue #31, IN FLIGHT). After VERIFY, rewrite this snapshot and pick: `UNAVAILABLE` in Assist, then PR #30 VERIFY, then live progress in Assist.

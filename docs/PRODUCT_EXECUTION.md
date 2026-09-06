# Product Execution Map

Living PM roadmap for Vision Landing Console. Not a frozen checklist. Not the GitHub backlog.

**Owner:** King (PM + Technical Lead + Project Manager). Cloud Agents implement; they do not own the plan.

**Language:** English. This file is the execution map. Product UI remains Hebrew RTL.

**Do not invent** `STATUS.md`. Constitution / work-rules live in `AGENTS.md` (LANDED on master via PR #6 merge `e57eb28`). Do not edit that file from this map.

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
3. **Pick next** using GAP > BUG > IMPROVEMENT. One next, in order. Prefer high-impact capability over chrome polish.
4. **Execute** on an isolated branch. Stay draft until King merges a verified safe draft, or a remaining Human Gate says otherwise.

Rules:

- King rewrites the snapshot after VERIFY. Old snapshot dates may stay as a one-line pointer; the current snapshot is the plan.
- Discover GAPS. Do not only consume Issues.
- Do not ask Roy what to work on next unless vision, safety, scope, or two materially different product choices require him.
- WAITING FOR ROY blocks only that decision.
- Human Gates stay Human Gates even if a GAP is large.
- Roy 2026-09-05: King may merge verified safe draft PRs without asking (Merge Autonomy, on master via PR #6).
- Decision options presented to Roy must carry meaning hints (what choosing the option does), not bare labels.

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
- Secrets / deploy to devices / flight commands

Merge: Roy 2026-09-05 — King may merge **verified safe** draft PRs without asking (Merge Autonomy + Decision Option Hints, LANDED on master via PR #6 `e57eb28`). This map LANDED via PR #32 `6d8fbbf`. Decision options must carry meaning hints.

Also locked without GO:

- Mock GPS (HUD GPS–Vision delta stays `-- m` until real GPS)
- Fake agent runs when the provider is `UNAVAILABLE`
- Live Jetson connect until Roy supplies the Companion token (token is not in Cursor / PC `.env`; Jetson `:8081` returns 401 without it)

---

## Milestones

| ID | Capability | Gate |
|---|---|---|
| **A** | In-product isolated agent loop: Assist Confirm starts a Cursor Agent on an isolated branch | **LANDED** on master 2026-08-25 via PR #33 merge `51d2ef41`. Issue #31 done on master. |
| **B** | Results visible in Assist (status, then live progress, then outcome) | **LANDED** with A. Operator can connect the coding agent from Assist (PR #34). UNAVAILABLE stays honest for empty/invalid key. |
| **C** | Companion apply after GO | Human Gate (#28). No GO. In-product connect + events SSE landed (#39, #40). Live Jetson proof parked on token. |
| **D** | Flight ops + auto-land after GO | Human Gate (#29). No GO. |

Params persist on master via PR #18 + PR #30. Write-to-vehicle is still a Human Gate.

---

## Near-term (do, in this order)

1. Assist Confirm starts an isolated Cursor Agent and returns Hebrew status/result. **LANDED on master** via PR #33. Issue #31 done on master; GitHub close blocked.
2. Operator can connect the coding agent from Assist. **LANDED on master** via PR #34. Empty/invalid key stays UNAVAILABLE. Do not fake READY.
3. In-product Companion API v1 connect + events SSE. **LANDED on master** via PR #39 and PR #40. Read / status / overlay only. Apply/restart still Human Gate.
4. Live Jetson connect is **parked** until Roy remembers the Companion token. Token is not in Cursor / PC `.env`. Jetson `:8081` returns 401 without it. Do not invent a token. Do not fake a live connect.
5. Human Gates stay WAITING FOR ROY: companion apply/restart (#28), live vehicle / auto-landing (#29), secrets / deploy / flight commands.
6. 300+ hunt is **abandoned permanently**. GitHub public `master` is `1.02.255`. Improve GitHub 255. Prefer high-impact capability over chrome polish.
7. Skip leftover draft #4 (low-value smoke). Do not merge. Constitution #6 **LANDED** on master `e57eb28`. This map **LANDED** on master `6d8fbbf`.
8. Do not create chrome / copy / changelog PRs while destination GAPS remain. Changelog #15 is already on master. Do not ask Roy what to work on next.

---

## Audit snapshot — 2026-09-06 (post #46 land)

**Master:** `1.02.255` @ `f278bff` (PR #46 merge — Telemetry disconnected-first). Parent includes PR #45 `5d9d8ce` (Hebrew leftover operator chrome) and PR #44 `c737aa3` (disconnected-first / zoom-out on Maintenance / Companion / Development). Do not bump.  
**Prior pointer:** 2026-09-06 post-#45 snapshot listed Telemetry disconnected-first as this draft. That is superseded. #46 is now **LANDED**. #6 and #32 remain **LANDED**.  
**This draft:** Params Hebrew leftover labels (operator-visible PARAMS list + abort-tab chrome). Copy-only. Do not bump `APP_VERSION`.

Ops (not product): WhatsApp Human Gate delivery is signed in on the operator box targeting +972584010075 (self-chat).

### LANDED since the stale snapshot (true)

- PR #46 Telemetry disconnected-first hierarchy → master `f278bff`.
- PR #45 Hebrew leftover operator chrome on Telemetry + Maintenance → master `5d9d8ce`.
- PR #44 disconnected-first / zoom-out operator overview on Maintenance / Companion / Development → master `c737aa3`.
- PR #6 `AGENTS.md` constitution + Merge Autonomy + Decision Option Hints → master `e57eb28`.
- PR #32 `PRODUCT_EXECUTION.md` living map → master `6d8fbbf`.

### Also already on master (from earlier)

- PR #39 in-product Companion API v1 connect (`bc19828`). Hebrew RTL form (base URL + token). Connect writes **BOTH** `COMPANION_MODE=real` and a URL. Persist in SQLite `server_config.companionConnection`. Token last-4 only. Read / status / connect only. No apply/restart.
- PR #40 Companion `/api/v1/events` SSE preferred over 1s status poll (`a6fc5e8`). Poll remains fallback. Browser still uses one `EventSource('/api/stream')`. Overlay only.
- PR #37 hide empty Maintenance deploy/rollback confirm modal (`de24ba1`). CSS `[hidden]` wins. Hebrew deploy/rollback copy. Does not execute deploy.
- PR #38 Hebrew Development Tasks chrome in `index.html` (`f4acc74`). Nav `DEVELOPMENT` → `פיתוח`. Behavior / ids / enums unchanged.
- PR #41 Hebrew Development Tasks leftovers in `app.js` (`afb1972`). User-visible filter / error / confirm copy. Enums stay English.
- PR #30 param-set RAM updates persist through SQLite `server_config` (`2036fbb`). Follow-on to #18. No live FC `PARAM_SET` as a new product capability.
- PR #15 rewrite dummy `1.02.254` / `1.02.255` changelog rows as product copy (`09fad00`). Issues #12 / #16 done on master — close later.

### Already on master (keep)

- Connections persist in SQLite (PR #5).
- Companion real mode requires **BOTH** `COMPANION_MODE=real` **and** `JETSON_COMPANION_BASE_URL` (PR #20). A URL alone must never enable real. In-product connect (#39) writes both.
- Companion RUNTIME config is save-not-apply (PR #25). Persistent Hebrew note: saved, not applied.
- Companion policy editor unwraps the GET envelope so channels hydrate (PR #24).
- HUD GPS–Vision delta stays `-- m` until real GPS. Do not invent mock GPS (PR #22).
- Vision config + `arduTargetParams` persist via SQLite `server_config` on `POST /api/vision/config` (PR #18). Param-set now uses the same snapshot (PR #30).
- Assist Confirm / Cancel labels are Hebrew (PR #9). Issues #8 / #10 are done on master — close later.
- Development Tasks empty-state copy is Hebrew (PR #13). Chrome + `app.js` leftovers landed (#38, #41). Issue #14 done on master — close later.
- Assist confirm → isolated agent → result in Assist (PR #33). Issue #31 done on master; GitHub close blocked.
- Assist connect-from-screen (PR #34). Empty/invalid key stays UNAVAILABLE.
- Hebrew Assist development phrasing (PR #35). Hebrew Assist answers (PR #36). Coding-agent `last_message` stays English by design.

### Companion (connect + events landed; live proof parked)

On master today (PR #39 + PR #40):

- Operator can point the console at a Companion API v1 base from the product. Connect is the explicit action that enables real. A stored URL without `connected` leaves companion off.
- Token persists in SQLite. Never logged or returned in full. UI shows last-4.
- Real mode prefers Companion `/api/v1/events` SSE; poll is fallback. Mock mode is unchanged.
- Live Jetson proof is **parked**. Token is not in Cursor / PC `.env`. Jetson `:8081` returns 401 without it. Roy must remember the token. Do not invent one. Do not treat 401 as a product bug.
- Apply / restart / policy-apply remain Human Gate (#28). No GO.

### Params (persist landed)

`POST /api/param-center/param-set` now persists through the same `server_config` snapshot as vision config (PR #18 + PR #30). Issue #27 done on master — close later. Live FC `PARAM_SET` as a product capability remains a Human Gate.

### Open drafts

| PR | Topic | This map |
|---|---|---|
| this draft | Params Hebrew leftover labels | **This draft.** Copy-only PARAMS list + abort-tab chrome. Stay draft until VERIFY. Not a Human Gate. Do not merge from this agent. |
| [#4](https://github.com/royshiber/vision-landing-console/pull/4) | PM orchestrator smoke | Skip. Low-value. Do not merge. |

### LANDED drafts (were open on the prior 2026-09-05 snapshot)

| PR | Topic | This map |
|---|---|---|
| [#46](https://github.com/royshiber/vision-landing-console/pull/46) | Telemetry disconnected-first hierarchy | **LANDED** on master `f278bff`. Not an open draft. |
| [#6](https://github.com/royshiber/vision-landing-console/pull/6) | `AGENTS.md` constitution + Merge Autonomy + Decision Option Hints | **LANDED** on master `e57eb28`. Not an open draft. |
| [#32](https://github.com/royshiber/vision-landing-console/pull/32) | This living map | **LANDED** on master `6d8fbbf`. Not an open draft. |
| [#15](https://github.com/royshiber/vision-landing-console/pull/15) | Changelog product copy | **LANDED** on master `09fad00`. Not a skip. |

### Open issues

GitHub Issues write is still blocked for the Cursor GitHub App. Done issues stay open; close later.

| Issue | Topic | Class |
|---|---|---|
| [#7](https://github.com/royshiber/vision-landing-console/issues/7) | Constitution in `AGENTS.md` | **Done on master.** PR #6 merged `e57eb28`. Constitution landed. Close later. |
| [#8](https://github.com/royshiber/vision-landing-console/issues/8) / [#10](https://github.com/royshiber/vision-landing-console/issues/10) | Assist Confirm/Cancel English | Done on master (PR #9). Close later. |
| [#12](https://github.com/royshiber/vision-landing-console/issues/12) / [#16](https://github.com/royshiber/vision-landing-console/issues/16) | Changelog dump rows | **Done on master** via PR #15. Close later. |
| [#14](https://github.com/royshiber/vision-landing-console/issues/14) | Remaining Development English chrome | **Done on master** via #13 + #38 + #41. Close later. |
| [#27](https://github.com/royshiber/vision-landing-console/issues/27) | Params persist | **Done on master** via #18 + #30. Close later. Write-to-vehicle is Human Gate. |
| [#28](https://github.com/royshiber/vision-landing-console/issues/28) | Companion apply/restart | GAP + Human Gate. Highest remaining destination code. No GO. |
| [#29](https://github.com/royshiber/vision-landing-console/issues/29) | Live vehicle + auto-landing | GAP + Human Gate. Next remaining destination value. No GO. |
| [#31](https://github.com/royshiber/vision-landing-console/issues/31) | In-product Cursor Agent loop | **Done on master.** PR #33 merged `51d2ef41` 2026-08-25. GitHub close blocked. |

### Version hunt (abandoned)

Roy 2026-09-05: abandon searching the local tree for versions past 300 **permanently**. GitHub public `master` is `1.02.255`. Improve GitHub 255. Prefer high-impact capability over chrome polish. Do not treat a missing 302+ tree as a GAP.

### Ranked GAPS (this snapshot)

1. **Live Jetson connect proof** — parked. Capability is on master (#39 / #40). Blocked on Companion token (not in Cursor / PC `.env`; Jetson `:8081` → 401). WAITING FOR ROY on the token, not more connect code. Do not invent a token.
2. **Companion apply/restart** — Human Gate. Issue #28. Milestone C. Highest remaining destination *code*. No GO. Stay **WAITING FOR ROY**.
3. **Live vehicle + auto landing** — Human Gate. Issue #29. Milestone D. No GO. Stay **WAITING FOR ROY**.
4. **Independent high-impact capability on GitHub 255** — only if it closes destination distance and is not Human Gate / not parked token / not chrome.

### Explicitly not next

Do not spend cycles on smoke #4, more leftover Hebrew chrome beyond this Params labels draft, version bump, 300+ hunt, inventing a Companion token, Jetson apply/restart, or flight commands. #46 Telemetry disconnected-first is landed. #45 leftover chrome is landed. #44 zoom-out is landed on Maintenance / Companion / Development. Do not invent a token. Do not fake a live Jetson connect.

### Next pick (this snapshot)

**This draft = Params Hebrew leftover labels.** Translate remaining English operator-visible PARAMS labels (example: `Cross Track Gain`) and abort-tab chrome. Keys / wire / FC enums stay English. Jetson still parked on the Companion token. Do not invent a token. Human Gates stay **WAITING FOR ROY**: #28 apply/restart, #29 live vehicle / auto-land. `APP_VERSION` stays `1.02.255`. Do not ask Roy what to work on next.

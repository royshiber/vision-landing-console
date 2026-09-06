# Product Execution Map

Living PM snapshot for Vision Landing Console. Not a frozen checklist. Not the GitHub backlog.

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
- Roy 2026-09-05: King may merge verified safe draft PRs without asking (Merge Autonomy, on master via PR #6). Still on.
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

Merge: Roy 2026-09-05 — King may merge **verified safe** draft PRs without asking (Merge Autonomy + Decision Option Hints, LANDED on master via PR #6 `e57eb28`). Still on. Hard safety stops stay draft until Roy. This map last landed on master via PR #53 `1c165e0`. Decision options must carry meaning hints.

Also locked without GO:

- Mock GPS (HUD GPS–Vision delta stays `-- m` until real GPS)
- Fake agent runs when the provider is `UNAVAILABLE`
- Live Jetson connect until Roy supplies the Companion token (token is not in Cursor / PC `.env`; Jetson `:8081` returns 401 without it). Token wait is days, not a code task.

---

## Milestones

| ID | Capability | Gate |
|---|---|---|
| **A** | In-product isolated agent loop: Assist Confirm starts a Cursor Agent on an isolated branch | **LANDED** on master 2026-08-25 via PR #33 merge `51d2ef41`. Issue #31 done on master. |
| **B** | Connected Assist progress / result surface: Hebrew status → real progress → result card (open PR / dismiss) | **LANDED** on master 2026-09-06 via PR #52 merge `042c095`. Start + connect already on master (#33, #34). UNAVAILABLE stays honest. Remainder closed. |
| **C** | Companion apply after GO | Human Gate (#28). No GO. In-product connect + events SSE landed (#39, #40). Live Jetson proof parked on token. |
| **D** | Flight ops + auto-land after GO | Human Gate (#29). No GO. |

Params persist on master via PR #18 + PR #30. Write-to-vehicle is still a Human Gate.

Architecture wave (docs/AIRVIX_PRODUCT_ARCHITECTURE.md): C10.2 Assist unification landed; C10.3 Pulse home **LANDED** on master via PR #54. **Next phase: C10.4 Evolve workspace v2** (taxonomy + evidence + absorb release owner).

---

## Near-term (do, in this order)

1. Assist Confirm starts an isolated Cursor Agent and returns Hebrew status/result. **LANDED on master** via PR #33. Issue #31 done on master; GitHub close blocked.
2. Operator can connect the coding agent from Assist. **LANDED on master** via PR #34. Empty/invalid key stays UNAVAILABLE. Do not fake READY.
3. In-product Companion API v1 connect + events SSE. **LANDED on master** via PR #39 and PR #40. Read / status / overlay only. Apply/restart still Human Gate.
4. Operator first-impression UX. **LANDED on master** via PR #50 merge `560686c`. Hebrew Assist **מסייע**, Companion hero card, first-open next actions, muted lab tabs.
5. Prior living-map snapshot after #50. **LANDED on master** via PR #51 merge `ba78623`.
6. Assist connected progress/result card. **LANDED on master** via PR #52 merge `042c095`. Milestone B remainder closed.
7. Living-map snapshot after #52. **LANDED on master** via PR #53 merge `1c165e0`.
8. C10.3 Pulse home. **LANDED on master** via PR #54 merge `9f4e05bc47ddd6fb07a94acfa0852bf7137841e1`. Hebrew **סקירה** is the default home. `localStorage` `visionLandingHomeSurfaceV1` is `pulse` or `telemetry`. Existing tabs stay. No GPS invented.
9. Live Jetson connect is **parked** (days) until Roy remembers the Companion token. Token is not in Cursor / PC `.env`. Jetson `:8081` returns 401 without it. Do not invent a token. Do not fake a live connect.
10. Human Gates stay WAITING FOR ROY: companion apply/restart (#28), live vehicle / auto-landing (#29), secrets / deploy / flight commands.
11. **Next independent non-HG pick:** C10.4 Evolve workspace v2. Roy design notes remain deferred. Roy said continue and approved merge #54 after the Auto-review block.
12. 300+ hunt is **abandoned permanently**. GitHub public `master` is `1.02.255`. Improve GitHub 255. Measure by capabilities closed, not PR count.
13. Skip leftover draft #4 (low-value smoke). Do not merge. Constitution #6 **LANDED** on master `e57eb28`. Prior map snapshots **LANDED** via PR #49 `1c7f8fa`, PR #51 `ba78623`, and PR #53 `1c165e0`.

---

## Audit snapshot — 2026-09-06 (post #54 land)

**Master:** `1.02.255` @ `9f4e05bc47ddd6fb07a94acfa0852bf7137841e1` (PR #54 merge — C10.3 Pulse home). Do not bump.  
**Prior pointer:** 2026-09-06 post-#52 / #53 snapshot treated independent non-HG work as thin and waited on Roy design notes. That is superseded. #54 landed. Roy said continue and approved merge #54 after the Auto-review block. Design notes stay deferred. Architecture next phase is C10.4. #6, #50, #52, and #53 remain **LANDED**.  
**This draft:** rewrite of this living snapshot after PR #54. Docs only. Do not bump `APP_VERSION`. Stay draft. Do not merge from this agent.

Ops (not product): WhatsApp Human Gate delivery remains available (signed in on the operator box targeting +972584010075, self-chat).

### LANDED this capability close (2026-09-06)

- PR #54 C10.3 Pulse home → master `9f4e05bc47ddd6fb07a94acfa0852bf7137841e1`. Hebrew **סקירה** is the default operator home. Compressed console / companion / assist / link / aircraft status. Attention + Evolve glance + first-open actions. Home pref in `localStorage` `visionLandingHomeSurfaceV1` (`pulse` \| `telemetry`). Existing tabs stay (non-breaking). Link / aircraft stay placeholders. No mock GPS. `APP_VERSION` stayed `1.02.255`.

### Prior still on master (#50, #52, #53)

- PR #53 this living map rewrite after PR #52 → master `1c165e0`.
- PR #52 Assist connected progress/result card → master `042c095`. Hebrew status → real progress → result card (open PR / dismiss). UNAVAILABLE stays honest.
- PR #51 living map rewrite after PR #50 → master `ba78623`.
- PR #50 Operator first-impression UX → master `560686c`. Hebrew Assist **מסייע**. Companion hero card. First-open next actions. Muted lab tabs.
- UI/UX Hebrew + hierarchy round #43–#49 remains on master (`816d759` … `1c7f8fa`).

### Already on master (keep)

- PR #6 `AGENTS.md` constitution + Merge Autonomy + Decision Option Hints → master `e57eb28`. Merge autonomy still on for independently VERIFIED safe draft PRs (UX / copy / persist / connect non-apply). Hard safety stops stay draft until Roy.
- PR #32 first living map → master `6d8fbbf`. Later snapshots: #49 `1c7f8fa`, #51 `ba78623`, #53 `1c165e0`.
- PR #39 in-product Companion API v1 connect (`bc19828`). Hebrew RTL form (base URL + token). Connect writes **BOTH** `COMPANION_MODE=real` and a URL. Persist in SQLite `server_config.companionConnection`. Token last-4 only. Read / status / connect only. No apply/restart.
- PR #40 Companion `/api/v1/events` SSE preferred over 1s status poll (`a6fc5e8`). Poll remains fallback. Browser still uses one `EventSource('/api/stream')`. Overlay only.
- Companion real mode requires **BOTH** `COMPANION_MODE=real` **and** `JETSON_COMPANION_BASE_URL` (PR #20). A URL alone must never enable real. In-product connect (#39) writes both.
- Companion RUNTIME config is save-not-apply (PR #25). Persistent Hebrew note: saved, not applied.
- Companion policy editor unwraps the GET envelope so channels hydrate (PR #24).
- Connections persist in SQLite (PR #5).
- HUD GPS–Vision delta stays `-- m` until real GPS. Do not invent mock GPS (PR #22). Pulse home does not invent GPS either.
- Vision config + `arduTargetParams` persist via SQLite `server_config` on `POST /api/vision/config` (PR #18). Param-set uses the same snapshot (PR #30).
- Assist confirm → isolated agent → Hebrew status (PR #33). Issue #31 done on master; GitHub close blocked.
- Assist connect-from-screen (PR #34). Empty/invalid key stays UNAVAILABLE.
- Assist connected result card (PR #52). Hebrew status → real progress → open PR / dismiss. UNAVAILABLE stays honest. Do not invent progress.
- Hebrew Assist Confirm / Cancel (PR #9). Hebrew Assist development phrasing (PR #35). Hebrew Assist answers (PR #36). Coding-agent `last_message` stays English by design.
- Development Tasks empty-state + chrome leftovers (#13, #38, #41). Issue #14 done on master — close later.
- PR #37 hide empty Maintenance deploy/rollback confirm modal (`de24ba1`). Does not execute deploy.
- PR #15 rewrite dummy `1.02.254` / `1.02.255` changelog rows as product copy (`09fad00`). Issues #12 / #16 done on master — close later.

### Pulse (C10.3 landed)

On master today (PR #54):

- First paint is Hebrew **סקירה**, not Parameter Center.
- Status is compressed: console version, companion, assist, link, aircraft. Placeholders stay `--` until real values exist.
- Attention, Evolve glance, and first-open actions (companion / assist / params / develop / telemetry) sit on the home surface.
- Operator can keep Telemetry-first via `localStorage` `visionLandingHomeSurfaceV1` = `telemetry`. Default is `pulse`.
- Existing tabs remain. This is a non-breaking home, not an IA cliff-delete.
- Architecture contract (`docs/AIRVIX_PRODUCT_ARCHITECTURE.md`) now names **C10.4 Evolve workspace v2** as next.

### Companion (connect + events landed; live proof parked)

On master today (PR #39 + PR #40 + first-impression hero from #50 + Pulse companion glance from #54):

- Operator can point the console at a Companion API v1 base from the product. Connect is the explicit action that enables real. A stored URL without `connected` leaves companion off.
- Token persists in SQLite. Never logged or returned in full. UI shows last-4.
- Real mode prefers Companion `/api/v1/events` SSE; poll is fallback. Mock mode is unchanged.
- Live Jetson proof is **parked** (days). Token is not in Cursor / PC `.env`. Jetson `:8081` returns 401 without it. Roy must remember the token. Do not invent one. Do not treat 401 as a product bug.
- Apply / restart / policy-apply remain Human Gate (#28). No GO.

### Assist (start + connect + result card landed)

On master today (PR #33 + PR #34 + Hebrew Assist chrome from #50 + result card from #52 + Pulse assist glance from #54):

- Confirm starts an isolated Cursor Agent. Connect-from-Assist is the operator path.
- Connected run surface is a first-class card: Hebrew status, then real progress when the API has it, then a result card with open PR / dismiss.
- UNAVAILABLE stays honest. Empty/invalid key, `NOT_STARTED`, or `agent_started === false` never render as a healthy run. Do not invent progress.
- Milestone B remainder is closed. Do not spend the next cycle polishing this card.

### Params (persist landed)

`POST /api/param-center/param-set` now persists through the same `server_config` snapshot as vision config (PR #18 + PR #30). Issue #27 done on master — close later. Live FC `PARAM_SET` as a product capability remains a Human Gate.

### Open drafts

| PR | Topic | This map |
|---|---|---|
| This draft | Snapshot rewrite after PR #54 | **This draft.** Docs only. Stay draft. Do not merge from this agent. Not a next-pick polish PR. |
| [#4](https://github.com/royshiber/vision-landing-console/pull/4) | PM orchestrator smoke | Skip. Low-value. Do not merge. |

### Open issues

GitHub Issues write is still blocked for the Cursor GitHub App. Done issues stay open; close later.

| Issue | Topic | Class |
|---|---|---|
| [#7](https://github.com/royshiber/vision-landing-console/issues/7) | Constitution in `AGENTS.md` | **Done on master.** PR #6 merged `e57eb28`. Close later. |
| [#8](https://github.com/royshiber/vision-landing-console/issues/8) / [#10](https://github.com/royshiber/vision-landing-console/issues/10) | Assist Confirm/Cancel English | Done on master (PR #9). Close later. |
| [#12](https://github.com/royshiber/vision-landing-console/issues/12) / [#16](https://github.com/royshiber/vision-landing-console/issues/16) | Changelog dump rows | **Done on master** via PR #15. Close later. |
| [#14](https://github.com/royshiber/vision-landing-console/issues/14) | Remaining Development English chrome | **Done on master** via #13 + #38 + #41. Close later. |
| [#27](https://github.com/royshiber/vision-landing-console/issues/27) | Params persist | **Done on master** via #18 + #30. Close later. Write-to-vehicle is Human Gate. |
| [#28](https://github.com/royshiber/vision-landing-console/issues/28) | Companion apply/restart | GAP + Human Gate. Highest remaining destination code. No GO. Stay **WAITING FOR ROY**. |
| [#29](https://github.com/royshiber/vision-landing-console/issues/29) | Live vehicle + auto-landing | GAP + Human Gate. Next remaining destination value. No GO. Stay **WAITING FOR ROY**. |
| [#31](https://github.com/royshiber/vision-landing-console/issues/31) | In-product Cursor Agent loop | **Done on master.** PR #33 merged `51d2ef41` 2026-08-25. Result card PR #52 closed the milestone B remainder. GitHub close blocked. |

### Version hunt (abandoned)

Roy 2026-09-05: abandon searching the local tree for versions past 300 **permanently**. GitHub public `master` is `1.02.255`. Improve GitHub 255. Prefer high-impact capability over chrome polish. Do not treat a missing 302+ tree as a GAP.

### Ranked GAPS (this snapshot)

1. **C10.4 Evolve workspace v2** — highest-value independent non-HG gap. Taxonomy + evidence + absorb release owner (`docs/AIRVIX_PRODUCT_ARCHITECTURE.md`). Roy design notes stay deferred. Roy said continue.
2. **Live Jetson connect proof** — parked (days). Capability is on master (#39 / #40). Blocked on Companion token (not in Cursor / PC `.env`; Jetson `:8081` → 401). WAITING FOR ROY on the token, not more connect code. Do not invent a token.
3. **Companion apply/restart** — Human Gate. Issue #28. Milestone C. Highest remaining destination *code*. No GO. Stay **WAITING FOR ROY**.
4. **Live vehicle + auto landing** — Human Gate. Issue #29. Milestone D. No GO. Stay **WAITING FOR ROY**.

### Explicitly not next

Do not spend cycles on smoke #4, leftover disconnected chrome, version bump, 300+ hunt, inventing a Companion token, Jetson apply/restart, flight commands, or another Pulse polish pass. #50 / #52 / #54 are landed. Do not invent a token. Do not invent GPS. Do not fake a live Jetson connect.

### Next pick (this snapshot)

**C10.4 Evolve workspace v2** — taxonomy + evidence + absorb release owner. Independent, non-HG, architecture-named next phase. Roy design notes remain deferred; Roy said continue after approving merge #54 (Auto-review block). Jetson live connect stays parked until Roy supplies the Companion token (days; Jetson `:8081` → 401 without it). Human Gates stay **WAITING FOR ROY**: #28 apply/restart, #29 live vehicle / auto-land. Merge autonomy still on for verified safe draft PRs. Measure by capabilities closed, not PR count. `APP_VERSION` stays `1.02.255`.

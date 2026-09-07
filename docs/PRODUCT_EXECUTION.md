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

Merge: Roy 2026-09-05 — King may merge **verified safe** draft PRs without asking (Merge Autonomy + Decision Option Hints, LANDED on master via PR #6 `e57eb28`). Still on. Hard safety stops stay draft until Roy. This map last landed on master via PR #57 `b724c76`. This rewrite is draft [#60](https://github.com/royshiber/vision-landing-console/pull/60). Decision options must carry meaning hints.

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

Architecture wave (`docs/AIRVIX_PRODUCT_ARCHITECTURE.md`): C10.2 Assist unification landed; C10.3 Pulse home **LANDED** via PR #54; C10.4a Evolve taxonomy **LANDED** via PR #56; C10.4b Evolve evidence **LANDED** via PR #58; C10.4c-a Maintenance→Development release handoff **LANDED** via PR #61; C10.5a leftover `#flights` fold **LANDED** via PR #62; C10.5b Platform capability shells **LANDED** via PR #64 merge `779a11d`; C10.6 Mission flight-safe Assist **LANDED** via PR #65 merge `5184e71`; C10.7a Attention Policy **LANDED** via PR #66 merge `b37c26e`; Advisor→Assist MERGE **LANDED** via PR #67 merge `b0be4c3`; Flight Engineer→Assist MERGE **LANDED** via PR #68 merge `6b6218f`; Telemetry dash MERGE **LANDED** via PR #69 merge `1fe10df`; orphan `#processes` REMOVE **LANDED** via PR #70 merge `d67ce2a`; Preflight / readiness MERGE **LANDED** via PR #71 merge `4ce554e`; baseline test hygiene **LANDED** via PR #72 merge `d67d4d5`; ArduLab Assist fold **LANDED** via PR #73 merge `dca929a`; SITL Lab connect REFINE **LANDED** via PR #74 merge `1971384`; Auto-Config wizard MERGE **LANDED** via PR #75 merge `33d6334`; AIRVIX UI redesign (chrome + Mission workspace) is this draft. Remainder: C10.4c-b Jetson deploy-wire move stays deferred (#28). C10.7b voice/STT stays deferred.

---

## Near-term (do, in this order)

1. Assist Confirm starts an isolated Cursor Agent and returns Hebrew status/result. **LANDED on master** via PR #33. Issue #31 done on master; GitHub close blocked.
2. Operator can connect the coding agent from Assist. **LANDED on master** via PR #34. Empty/invalid key stays UNAVAILABLE. Do not fake READY.
3. In-product Companion API v1 connect + events SSE. **LANDED on master** via PR #39 and PR #40. Read / status / overlay only. Apply/restart still Human Gate.
4. Operator first-impression UX. **LANDED on master** via PR #50 merge `560686c`. Hebrew Assist **מסייע**, Companion hero card, first-open next actions, muted lab tabs.
5. Prior living-map snapshot after #50. **LANDED on master** via PR #51 merge `ba78623`.
6. Assist connected progress/result card. **LANDED on master** via PR #52 merge `042c095`. Milestone B remainder closed.
7. Living-map snapshot after #52. **LANDED on master** via PR #53 merge `1c165e0`.
8. C10.3 Pulse home. **LANDED on master** via PR #54 merge `9f4e05bc47ddd6fb07a94acfa0852bf7137841e1`. Hebrew **סקירה** is the default home. Existing tabs stay. No GPS invented.
9. Living-map snapshot after #54. **LANDED on master** via PR #55 merge `db6fdc0ac1575ab20c4a72470aa5350b16a1a72e`.
10. C10.4a first-class Evolve taxonomy. **LANDED on master** via PR #56 merge `a554d5224bbc1f99196f3e80c1e5123f91b06961`. Development Tasks store/API/UI **סיווג** is IDEA / REQUEST / IMPROVEMENT / BUG / EXPERIMENT / FEATURE. Assist CREATE writes taxonomy. No notes stuffing. Missing rows backfill to FEATURE.
11. Living-map snapshot after #56. **LANDED on master** via PR #57 merge `b724c76`.
12. C10.4b Evolve evidence strip. **LANDED on master** via PR #58 merge `6100247d1d27c76af5ca09293d7d99b97794f0b9`. Development task detail shows compact Hebrew cells **מה / למה / מצב / בדיקות / גרסה / גרסה רצה**. Read-only from existing task JSON. Empty stays `—` or `NOT_STARTED`. No invented progress, versions, or GPS.
13. Live Jetson connect is **parked** (days) until Roy remembers the Companion token. Token is not in Cursor / PC `.env`. Jetson `:8081` returns 401 without it. Do not invent a token. Do not fake a live connect.
14. Human Gates stay WAITING FOR ROY: companion apply/restart (#28), live vehicle / auto-landing (#29), secrets / deploy / flight commands.
15. **C10.4c-a** Maintenance product-release authoring CTAs fold to a spoken-Hebrew Development handoff — **LANDED** via PR #61. Remainder: C10.4c-b Jetson deploy-wire move stays **deferred** (#28).
16. 300+ hunt is **abandoned permanently**. GitHub public `master` is `1.02.255`. Improve GitHub 255. Measure by capabilities closed, not PR count.
17. Skip leftover draft #4 (low-value smoke). Do not merge. Constitution #6 **LANDED** on master `e57eb28`. Prior map snapshots **LANDED** via PR #49 `1c7f8fa`, PR #51 `ba78623`, PR #53 `1c165e0`, PR #55 `db6fdc0`, and PR #57 `b724c76`.
18. **C10.5a** leftover hidden `#flights` folds into תחקור לוגים — **LANDED** via PR #62.
19. **C10.5b** Platform capability shells — **LANDED** via PR #64 merge `779a11d`. One overview tab **פלטפורמה** links to existing Companion / Params / Maintenance. PR #69 adds **אבחונים** → existing `#telemetry`. No new write paths.
20. **C10.6** Mission flight-safe Assist polish — **LANDED** via PR #65 merge `5184e71`. `#terrain` / `#flightEngineer` stay MISSION. Assist drops `CREATE_DEVELOPMENT_TASK` there and refuses coding-agent starts in spoken Hebrew. NOTE / OBSERVATION / UI_NAVIGATION stay.
21. **C10.7a** Attention Policy controls — **LANDED** via PR #66 merge `b37c26e`. Quiet-by-default `off` / `attention` / `critical` in the existing gear. Pulse tags INFO/ATTENTION/CRITICAL. Assist badge only when policy allows noticing. No STT/TTS pipeline. C10.7b voice/STT stays deferred.
22. **Advisor→Assist MERGE** — **LANDED** via PR #67 merge `b0be4c3`. `#advisor` stays on the lab shelf. Assist routes `advisor` / `יועץ` and advisor-style Q&A to that panel. No cliff-delete.
23. **Flight Engineer→Assist MERGE** — **LANDED** via PR #68 merge `6b6218f`. `#flightEngineer` stays reachable (lab shelf / Mission). Assist routes `מהנדס` / flight engineer / voice engineer to that panel. Mission stays NOTE / OBSERVATION / UI_NAV. No flight commands. No cliff-delete.
24. **Telemetry dash MERGE** — **LANDED** via PR #69 merge `1fe10df`. `#telemetry` stays reachable. Platform **אבחונים** opens the existing panel. Primary ops tab is quieted. Pulse keeps compressed companion/link/aircraft. No GPS invented. Companion B2 / Jetson install-rollback writes stay gated / deferred (#28).
25. **Orphan `#processes` REMOVE** — **LANDED** via PR #70 merge `d67ce2a`. Dead DOM panel and stepper hooks gone. Live telemetry checklist / preflight strip stay. Stale session `processes` remaps to params. No GPS invented.
26. **Preflight / readiness MERGE** — **LANDED** via PR #71 merge `4ce554e`. One spoken-Hebrew **מוכנות** concept. Mission glance + Diagnostics checklist. SITL bar stays LAB-scoped with shared vocabulary. No GPS invented. PFD **פקודות** unchanged. No ARM / LAND / FC writes.
27. **Baseline test hygiene** — **LANDED** via PR #72 merge `d67d4d5`. `APP_VERSION` stayed `1.02.255`.
28. **ArduLab → Assist REFINE** — **LANDED** via PR #73 merge `dca929a`. Assist route `ardulab` opens existing `#featureDesigner`. Workspace **EVOLVE**. Lab shelf stays. No FC write / Companion apply / Jetson deploy.
29. **SITL Lab connect REFINE** — **LANDED** via PR #74 merge `1971384`. `#simLab` presets/wizard drive the global `#connectWidget`. Spoken-Hebrew handoff. One MAVLink connect truth.
30. **Auto-Config wizard MERGE** — **LANDED** via PR #75. Assist opens `#autoConfig` under Parameter Center (`#control`). Quiet Platform / Params chrome. Existing suggest→approve→apply stays. No new FC write.
31. **AIRVIX UI redesign (chrome + Mission workspace)** — **this draft.** Roy 2026-09-07 GO + complete IA LOCKED. Blue telemetry top strip removed. `#connectWidget` floats globally. Tabs sit in the freed top chrome. **הטסה** is a primary ops tab and the LOCKED app default open workspace (`#terrain`). Pulse home label stays **בית**. Mission regions are modular panes: drag any region onto another, resize columns/rows, persist, reset. Free edit on the ground, in flight, and on approach. The prior mid-flight-only swap/resize interim is overridden. Assist is a full Mission panel; outside Mission it is a floating button. Develop / Params / Settings stay available in the air. Short UI **Jetson**. Longer Hebrew **מחשב משימה**. No Companion apply/restart. No new FC write. No FLIGHT_ACTION. No GPS invented.

---

## Audit snapshot — 2026-09-07 (AIRVIX UI redesign this draft)

**Master:** `1.02.255` @ `33d6334` (PR #75 merge — Auto-Config wizard MERGE). Do not bump.  
**Prior pointer:** 2026-09-07 Auto-Config wizard MERGE draft snapshot. Superseded. #75 landed Assist → `#autoConfig`.  
**This draft:** AIRVIX UI redesign — chrome + Mission workspace + locked IA. Default open **הטסה**. Free Mission layout even in flight. Assist full panel on Mission, floating button elsewhere. Stay draft. Do not bump `APP_VERSION`.

Ops (not product): WhatsApp Human Gate delivery remains available (signed in on the operator box targeting +972584010075, self-chat).

### LANDED this capability close (2026-09-07)

- PR #74 SITL Lab connect REFINE → master `1971384`. `#simLab` presets/wizard drive `#connectWidget`. One MAVLink connect truth. Spoken-Hebrew handoff. Wizard teaching stays. No second TCP/UDP stack. `APP_VERSION` stayed `1.02.255`.
- PR #73 ArduLab → Assist REFINE → master `dca929a`. Assist route `ardulab` / `ארדולאב` opens existing `#featureDesigner`. Workspace **EVOLVE**. Lab shelf stays. No FC write / Companion apply / Jetson deploy. `APP_VERSION` stayed `1.02.255`.
- PR #72 baseline test hygiene → master `d67d4d5`. Advisor denylist / parseAttitude tests aligned. `APP_VERSION` stayed `1.02.255`.
- PR #71 Preflight / readiness MERGE → master `4ce554e`. One **מוכנות** concept. Mission glance + Diagnostics checklist. Assist `מוכנות` → Mission readiness. SITL bar stays LAB-scoped. No GPS invented. `APP_VERSION` stayed `1.02.255`.
- PR #70 orphan `#processes` REMOVE → master `d67ce2a`. Dead panel, stepper hooks, and unused `#preflightStatus` stub gone. Live telemetry checklist / `#preflightCard` stay. Stale session `processes` remaps to params. No GPS invented. `APP_VERSION` stayed `1.02.255`.
- PR #69 Telemetry dash MERGE → master `1fe10df`. Platform **אבחונים** opens existing `#telemetry`. Primary ops tab quieted. Pulse first-open uses **אבחונים**. Companion/link/aircraft glance stays. Panel stays. No GPS invented. `APP_VERSION` stayed `1.02.255`.
- PR #68 Flight Engineer→Assist MERGE → master `6b6218f`. Assist route `engineer` → MISSION `#flightEngineer`. `מהנדס` / flight engineer / voice engineer open that panel. Lab entry is **מהנדס מעבדה**. Panel stays. Mission stays flight-safe. `APP_VERSION` stayed `1.02.255`.
- PR #67 Advisor→Assist MERGE → master `b0be4c3`. Assist route `advisor` → LAB `#advisor`. Advisor-style Q&A opens the lab shelf. Lab entry is **יועץ מעבדה**. Panel stays. `APP_VERSION` stayed `1.02.255`.
- PR #66 C10.7a Attention Policy → master `b37c26e`. Quiet-by-default `off` / `attention` / `critical`. Pulse tags INFO/ATTENTION/CRITICAL. Assist badge only when policy allows noticing. No STT/TTS.
- PR #65 C10.6 Mission flight-safe Assist → master `5184e71`. `terrain` / `flightEngineer` stay MISSION. `available_actions` drop `CREATE_DEVELOPMENT_TASK`. DEVELOPMENT / REQUEST in Mission is a spoken-Hebrew refuse; no agent start. NOTE / OBSERVATION / UI_NAVIGATION stay.
- PR #64 C10.5b Platform capability shells → master `779a11d`. Hebrew **פלטפורמה** overview links existing Companion / Params / Maintenance. No new write paths.

### This draft (2026-09-07)

- AIRVIX UI redesign. Blue telemetry top strip gone. `#connectWidget` floats on every tab. **הטסה** is the LOCKED default open workspace. Pulse home label LOCKED **בית**. Mission regions `horizon | map | data | messages | talk` are modular panes: drag any region onto another, resize, persist, reset. Free edit on the ground, in flight, and on approach. Prior mid-flight-only swap/resize interim is overridden. Assist is a full Mission panel; outside Mission a floating button opens the existing rail. Develop / Params / Settings are not air-gated. Short UI **Jetson**. Longer Hebrew **מחשב משימה**. No Companion apply/restart. No new FC `PARAM_SET`. No FLIGHT_ACTION / ARM / LAND from Assist. Empty GPS stays `-- m`. `APP_VERSION` stays `1.02.255`.

### Prior still on master (#54, #56, #57)

- PR #57 this living map rewrite after PR #56 → master `b724c76`.
- PR #56 C10.4a first-class Evolve taxonomy → master `a554d5224bbc1f99196f3e80c1e5123f91b06961`. Locked types IDEA / REQUEST / IMPROVEMENT / BUG / EXPERIMENT / FEATURE. Hebrew UI **סיווג**. Assist CREATE writes taxonomy. Missing rows backfill to FEATURE.
- PR #55 living map rewrite after PR #54 → master `db6fdc0ac1575ab20c4a72470aa5350b16a1a72e`.
- PR #54 C10.3 Pulse home → master `9f4e05bc47ddd6fb07a94acfa0852bf7137841e1`. Hebrew **סקירה** is the default operator home. Home pref in `localStorage` `visionLandingHomeSurfaceV1` (`pulse` \| `telemetry`). Existing tabs stay. No mock GPS.
- PR #53 living map rewrite after PR #52 → master `1c165e0`.
- PR #52 Assist connected progress/result card → master `042c095`. Hebrew status → real progress → result card (open PR / dismiss). UNAVAILABLE stays honest.
- PR #51 living map rewrite after PR #50 → master `ba78623`.
- PR #50 Operator first-impression UX → master `560686c`. Hebrew Assist **מסייע**. Companion hero card. First-open next actions. Muted lab tabs.
- UI/UX Hebrew + hierarchy round #43–#49 remains on master (`816d759` … `1c7f8fa`).

### Already on master (keep)

- PR #6 `AGENTS.md` constitution + Merge Autonomy + Decision Option Hints → master `e57eb28`. Merge autonomy still on for independently VERIFIED safe draft PRs (UX / copy / persist / connect non-apply). Hard safety stops stay draft until Roy.
- PR #32 first living map → master `6d8fbbf`. Later snapshots: #49 `1c7f8fa`, #51 `ba78623`, #53 `1c165e0`, #55 `db6fdc0`, #57 `b724c76`.
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

- First paint is Hebrew **סקירה**, not Parameter Center. **This draft** locks the operator-facing Pulse label to **בית** (not סקירה, not תמונת מצב).
- Status is compressed: console version, companion, assist, link, aircraft. Placeholders stay `--` until real values exist.
- Attention, Evolve glance, and first-open actions (companion / assist / params / develop / telemetry) sit on the home surface.
- Operator can keep Telemetry-first via `localStorage` `visionLandingHomeSurfaceV1` = `telemetry`. Default is `pulse`.
- Existing tabs remain. This is a non-breaking home, not an IA cliff-delete.
- **Telemetry dash MERGE LANDED** via PR #69 `1fe10df`: Pulse first-open label is **אבחונים**. Companion/link/aircraft glance stays compressed. `#telemetry` is no longer a loud ops peer.
- PR #59 landed spoken Hebrew chrome and dropped Pulse filler lede / kicker. Do not start a second Pulse rewrite.
- **C10.7a LANDED** via PR #66 `b37c26e`: Pulse attention items stay visible and are tagged INFO / ATTENTION / CRITICAL. Policy `off` does not hide the list and does not add chimes.

### Evolve (C10.4a + C10.4b + C10.4c-a landed)

On master today (PR #56 + PR #58):

- Development Tasks persist a first-class `taxonomy`: IDEA / REQUEST / IMPROVEMENT / BUG / EXPERIMENT / FEATURE.
- Store, list/filter API, create, and patch all carry taxonomy. Hebrew UI **סיווג** on create, filters, table, and detail.
- Assist CREATE writes taxonomy on the task. Do not stuff the type into notes.
- Rows missing taxonomy backfill to FEATURE.
- Development task detail opens with a compact evidence strip: **מה / למה / מצב / בדיקות / גרסה / גרסה רצה**. Bind is read-only from existing task / pipeline fields. Empty stays honest.
- C10.4 is **not closed**. **C10.4c-a LANDED** via PR #61: Maintenance demotes deploy/rollback authoring CTAs to a Hebrew handoff into Development `#devReleaseSection`; active/previous + backups/health stay read-only. Remainder is **C10.4c-b** Jetson deploy-wire move — still **deferred** (#28).

### Companion (connect + events landed; live proof parked)

On master today (PR #39 + PR #40 + first-impression hero from #50 + Pulse companion glance from #54):

- Operator can point the console at a Companion API v1 base from the product. Connect is the explicit action that enables real. A stored URL without `connected` leaves companion off.
- Token persists in SQLite. Never logged or returned in full. UI shows last-4.
- Real mode prefers Companion `/api/v1/events` SSE; poll is fallback. Mock mode is unchanged.
- Live Jetson proof is **parked** (days). Token is not in Cursor / PC `.env`. Jetson `:8081` returns 401 without it. Roy must remember the token. Do not invent one. Do not treat 401 as a product bug.
- Apply / restart / policy-apply remain Human Gate (#28). No GO.

### Assist (start + connect + result card landed)

On master today (PR #33 + PR #34 + Hebrew Assist chrome from #50 + result card from #52 + Pulse assist glance from #54 + taxonomy write from #56):

- Confirm starts an isolated Cursor Agent. Connect-from-Assist is the operator path.
- Connected run surface is a first-class card: Hebrew status, then real progress when the API has it, then a result card with open PR / dismiss.
- CREATE_DEVELOPMENT_TASK writes taxonomy instead of stuffing notes.
- UNAVAILABLE stays honest. Empty/invalid key, `NOT_STARTED`, or `agent_started === false` never render as a healthy run. Do not invent progress.
- Milestone B remainder is closed. Do not spend the next cycle polishing this card.
- **C10.6 LANDED** via PR #65 `5184e71`: Mission (`terrain` / `flightEngineer`) drops `CREATE_DEVELOPMENT_TASK` from `available_actions`. DEVELOPMENT / REQUEST there is a spoken-Hebrew refuse; no agent start. NOTE / OBSERVATION / known-route nav stay. Rail hint/placeholder/chips. `#terrain` keeps a small הטסה identity.
- **C10.7a LANDED** via PR #66 `b37c26e`: Attention Policy chrome only. Quiet default. Assist badge when policy allows. No voice/STT.
- **Advisor→Assist MERGE LANDED** via PR #67 `b0be4c3`: Assist opens the lab advisor for `יועץ` / advisor-style Q&A. `#advisor` stays reachable. Not a competing primary chat.
- **Flight Engineer→Assist MERGE LANDED** via PR #68 `6b6218f`: Assist opens `#flightEngineer` for `מהנדס` / voice-ops notes. Panel stays on the lab shelf. Mission stays flight-safe. PFD **פקודות** stays where it is.
- **Preflight / readiness MERGE LANDED** via PR #71 `4ce554e`: One **מוכנות** concept. Mission glance opens the existing popover. Diagnostics keeps the checklist. Assist `מוכנות` → Mission readiness. SITL bar stays LAB-scoped. No GPS invented. No flight commands.
- **ArduLab → Assist REFINE LANDED** via PR #73 `dca929a`: Assist opens `#featureDesigner` for `ארדולאב` / feature designer. Workspace **EVOLVE**. Lab shelf stays. Not a competing primary chat. No FC / Companion apply.
- **SITL Lab connect REFINE LANDED** via PR #74 `1971384`: `#simLab` presets/wizard drive `#connectWidget`. One MAVLink connect truth. Spoken-Hebrew handoff. Wizard teaching stays. Assist `סימולציה` / `sitl` → `#simLab`.
- **Auto-Config wizard MERGE LANDED** via PR #75 `33d6334`: Assist opens `#autoConfig` for `אשף` / `קונפיג אוטומטי`. Quiet Platform / Params chrome. Panel stays. No new vehicle write.
- **AIRVIX UI redesign this draft:** chrome + Mission workspace. Connect floats. **הטסה** default open. Free Mission layout on the ground, in flight, and on approach (drag / resize / persist / reset). Assist full panel on Mission; floating Assist elsewhere. Pulse home LOCKED **בית**. Short UI **Jetson**. Longer Hebrew **מחשב משימה**.

### Params (persist landed)

`POST /api/param-center/param-set` now persists through the same `server_config` snapshot as vision config (PR #18 + PR #30). Issue #27 done on master — close later. Live FC `PARAM_SET` as a product capability remains a Human Gate. **Auto-Config wizard MERGE LANDED** via PR #75. Assist + Platform chrome open existing `#autoConfig`. Suggest→approve→apply is unchanged. This redesign does not widen FC writes.

### Open drafts

| PR | Topic | This map |
|---|---|---|
| this draft | AIRVIX UI redesign — chrome + Mission workspace + locked naming + Mission-first default | **This draft.** Stay draft. King merges after independent VERIFY. |
| [#75](https://github.com/royshiber/vision-landing-console/pull/75) | Auto-Config wizard MERGE into Assist + Configuration | **LANDED** on master via PR #75 merge `33d6334`. |
| [#74](https://github.com/royshiber/vision-landing-console/pull/74) | SITL Lab connect REFINE — one `#connectWidget` truth | **LANDED** on master via PR #74 merge `1971384`. |
| [#73](https://github.com/royshiber/vision-landing-console/pull/73) | ArduLab → Assist REFINE fold | **LANDED** on master via PR #73 merge `dca929a`. |
| [#72](https://github.com/royshiber/vision-landing-console/pull/72) | Baseline test hygiene | **LANDED** on master via PR #72 merge `d67d4d5`. |
| [#71](https://github.com/royshiber/vision-landing-console/pull/71) | Preflight / readiness MERGE | **LANDED** on master via PR #71 merge `4ce554e`. |
| [#70](https://github.com/royshiber/vision-landing-console/pull/70) | Orphan `#processes` dead-DOM REMOVE | **LANDED** on master via PR #70 merge `d67ce2a`. |
| [#69](https://github.com/royshiber/vision-landing-console/pull/69) | Telemetry dash MERGE into Pulse + Platform diagnostics | **LANDED** on master via PR #69 merge `1fe10df`. |
| [#68](https://github.com/royshiber/vision-landing-console/pull/68) | Flight Engineer→Assist MERGE fold | **LANDED** on master via PR #68 merge `6b6218f`. |
| [#67](https://github.com/royshiber/vision-landing-console/pull/67) | Advisor→Assist MERGE fold | **LANDED** on master via PR #67 merge `b0be4c3`. |
| [#66](https://github.com/royshiber/vision-landing-console/pull/66) | C10.7a Attention Policy controls | **LANDED** on master via PR #66 merge `b37c26e`. |
| [#65](https://github.com/royshiber/vision-landing-console/pull/65) | C10.6 Mission flight-safe Assist polish | **LANDED** on master via PR #65 merge `5184e71`. |
| [#64](https://github.com/royshiber/vision-landing-console/pull/64) | Platform capability shells | **LANDED** on master via PR #64 merge `779a11d`. |
| [#60](https://github.com/royshiber/vision-landing-console/pull/60) | Living-map snapshot after #58 | **LANDED** on master via PR #60. |
| [#59](https://github.com/royshiber/vision-landing-console/pull/59) | Spoken Hebrew chrome, kill Pulse filler, group lab tabs | **LANDED** on master via PR #59. |
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

1. **AIRVIX UI redesign** — this draft. Chrome + Mission workspace + locked IA (בית / Jetson / מחשב משימה / default הטסה / free layout / docked Assist). No new FC write.
2. **C10.7b voice/STT** — deferred. Do not start now. No new ElevenLabs/STT secrets.
3. **C10.4c-b Jetson deploy-wire move** — remaining C10.4 slice. Still **deferred** (#28). Do not start now.
4. **Live Jetson connect proof** — parked (days). Capability is on master (#39 / #40). Blocked on Companion token (not in Cursor / PC `.env`; Jetson `:8081` → 401). WAITING FOR ROY on the token, not more connect code. Do not invent a token.
5. **Companion apply/restart** — Human Gate. Issue #28. Milestone C. Highest remaining destination *code*. No GO. Stay **WAITING FOR ROY**.
6. **Live vehicle + auto landing** — Human Gate. Issue #29. Milestone D. No GO. Stay **WAITING FOR ROY**.

### Explicitly not next

Do not spend cycles on smoke #4, leftover disconnected chrome, version bump, 300+ hunt, inventing a Companion token, Jetson apply/restart, flight commands, another Pulse polish pass, another taxonomy polish pass, another evidence-strip polish pass, Companion B2 policy rewrite, C10.7b voice/STT, or C10.4c-b Jetson deploy-wire move. #50 / #52 / #54 / #56 / #58 / #59 / #61 / #62 / #64 / #65 / #66 / #67 / #68 / #69 / #70 / #71 / #72 / #73 / #74 are landed. Do not invent a token. Do not invent GPS. Do not fake a live Jetson connect. Do not add ElevenLabs/STT keys.

### Next pick (this snapshot)

**AIRVIX UI redesign** is this draft. Auto-Config wizard landed via #75 @ `33d6334`. C10.7b voice/STT stays deferred. Remainder **C10.4c-b** Jetson deploy-wire move stays deferred (#28). Jetson live connect stays parked until Roy supplies the Companion token (days; Jetson `:8081` → 401 without it). Human Gates stay **WAITING FOR ROY**: #28 apply/restart, #29 live vehicle / auto-land. Merge autonomy still on for verified safe draft PRs. Measure by capabilities closed, not PR count. `APP_VERSION` stays `1.02.255`.

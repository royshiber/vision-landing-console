# AIRVIX Product Architecture — Capability Map + IA Contract

**Phase:** C10.1  
**Status:** Contract locked for implementation planning  
**Scope:** Architecture and product contracts only — no UI rewrite, no Assistant/voice implementation, no Jetson/FC/Agent/Release behavior changes in this phase.

---

## 1. Product thesis

AIRVIX is a unified interactive system for **operating, understanding, interacting with, and evolving** an autonomous aircraft platform.

It is simultaneously:

- an **engineering console**
- an **operational console**
- a **contextual assistant**
- a **development environment**

It is **not**:

- primarily a Ground Control Station competing with Mission Planner
- primarily an IDE competing with Cursor
- primarily a chatbot with panels bolted on

**Primary product objective:** minimize time from an observation, question, idea, request, or desired improvement to a **working, verified capability**.

The system is designed for a **single primary user** first (operator/engineer). Multi-user collaboration, roles, and org tenancy are out of scope for this contract.

---

## 2. Core loop

```
OBSERVE
  → UNDERSTAND
  → INTERACT
  → CREATE / CHANGE
  → VERIFY
  → DEPLOY
  → OBSERVE AGAIN
```

With a mandatory human gate for consequential change:

```
OBSERVE → UNDERSTAND → SUGGEST → USER APPROVES → APPLY → VERIFY
```

AIRVIX may **suggest** aggressively. AIRVIX must **never autonomously implement** a proposed solution that mutates aircraft behavior, flight state, product code, or deployment without explicit user approval (see §12).

---

## 3. Primary information architecture

### Locked chrome

```
PULSE | MISSION | PLATFORM | EVOLVE | LAB          [ ASSIST ]
```

| Surface | Kind | Role |
|---------|------|------|
| **PULSE** | Primary workspace (home) | What is happening and what should I care about now? |
| **MISSION** | Primary workspace | Focused in-flight / operational flying surface |
| **PLATFORM** | Primary workspace | Capability-centric engineering of the aircraft system |
| **EVOLVE** | Primary workspace | Idea → verified release → deploy → proof |
| **LAB** | Primary workspace | SITL, experiments, non-production tools |
| **ASSIST** | Persistent interaction layer | Text/voice context router — **not** a peer tab |

### Locked distinctions

| Concept | Meaning |
|---------|---------|
| **OPERATE / ASSIST / EVOLVE** | Jobs-to-be-done — **not** three top-level tabs |
| **CUSTOMIZE** | Personal layout, visibility, workspace preferences — no product code change |
| **DEVELOP** | Product code change via task → agent → worktree → tests → release → deploy |
| **UI ~70% / Voice ~30%** | UI remains primary; voice rises in importance when hands are on the RC |

### Development taxonomy (locked)

Ideas and bugs are equal citizens. Development is not “problem → fix” only.

| Type | Intent |
|------|--------|
| **IDEA** | Something that would be useful or interesting |
| **REQUEST** | Explicit ask for a change or capability |
| **IMPROVEMENT** | Efficiency, clarity, or quality upgrade |
| **BUG** | Incorrect or broken behavior |
| **EXPERIMENT** | Time-boxed try; may not ship |
| **FEATURE** | Named capability to add or extend |

---

## 4. Capability model

### Purpose

A **lightweight capability registry** helps AIRVIX evolve without redesigning the whole app for every new feature. It is **not** a plugin marketplace and **not** a third-party extension platform.

### Capability record (contract)

```text
Capability {
  id:            string          // stable slug, e.g. vision
  name:          string          // human label
  description:   string          // one-paragraph job statement
  uiModule:      reference?      // Platform (or Mission/Lab) presentation
  apiSources:    string[]        // console routes / companion surfaces / stores
  diagnostics:   reference?      // health, confidence, failure cues
  configuration: reference?      // params, policies, settings owned by this capability
  actions:       ActionRef[]     // gated by Approval Contract (§12)
  evolveHints:   string[]        // how IDEAs typically touch this capability
  memoryHints:   string[]        // what long-term history matters here (§13)
}
```

### Candidate capabilities (initial set)

| id | Name | Primary home | Notes |
|----|------|--------------|-------|
| `vision` | Vision | Platform (+ Mission glance) | Confidence, pipelines, VIO/flow/SLAM cues |
| `landing` | Landing | Platform (+ Mission glance) | Approach, abort, landing confidence |
| `navigation` | Navigation | Platform (+ Mission) | Visual nav / position relative cues |
| `mission` | Mission ops | Mission | Fly mode, map, safe ops actions |
| `video` | Video | Platform / Mission | Streams, overlays — not a dumping ground for all UI |
| `voice` | Voice | Assist plumbing | STT/TTS/ElevenLabs hooks; policy for proactivity |
| `diagnostics` | Diagnostics | Platform (+ Pulse attention) | Cross-cutting health; may surface on Pulse |
| `companion` | Companion | Platform | Jetson/companion status, install surfaces (policy-gated) |
| `configuration` | Configuration | Platform | Param center depth, profiles, smart search |
| `precision_landing` | Precision Landing | Platform (future) | Example of a capability that may introduce new UI module + evolve path |
| `debrief` | Debrief | Platform | Recordings, logs, post-flight review |
| `evolve` | Evolve pipeline | Evolve | Meta-capability: tasks, agent, tests, release, deploy |
| `lab_sitl` | SITL Lab | Lab | Simulation only — never implies production aircraft state |

New product capabilities (e.g. Precision Landing Zones) should register into this model: data/API → logic → UI module → diagnostics → optional Evolve seed — without inventing a new top-level tab family.

---

## 5. PULSE

### Purpose

**“What is happening and what should I care about now?”**

Pulse is the **home workspace**. It optimizes time-to-understand and time-to-decide.

### Primary user

The single primary operator/engineer at the start of a session or between deep work.

### Primary information

- Aircraft / link / companion **state** (compressed, explainable)
- **Attention** items (info / attention / critical — see Attention Policy in §10)
- Active **Evolve** work (open ideas/tasks, blocked waits)
- Recent **changes** (releases, deploys, notable applies) with evidence links
- Recent **context** (notes, observations) — not full chat transcript dumps

### Primary actions

- Open Mission / Platform capability / Evolve item
- Capture NOTE / IDEA / REQUEST into Assist or Evolve (with approval rules)
- Acknowledge / snooze attention items (UI_ACTION)
- Jump to verification evidence for a recent deploy

### Does **not** belong in Pulse

- Full Parameter Center
- Raw multi-column telemetry dumps
- Generic KPI wallpaper dashboards
- Full agent chat
- SITL controls
- Release authoring UI

---

## 6. MISSION

### Purpose

Focused **operational / in-flight** workspace. Basic GCS is acceptable. Engineering velocity remains the product bet; Mission must not become Mission Planner.

### Primary user

Operator with eyes on the aircraft; often **hands on RC** → voice rises in importance.

### Primary information

- Basic PFD / HUD glanceables
- Map
- Selected telemetry (mode, alt, IAS, GPS/vision confidence — not every sensor)
- Vision / landing cues relevant to the current phase
- Safe operational status strips

### Primary actions

- Safe operational actions (policy-gated; explicit confirmation when required)
- Voice / text Assist in **flight-safe** posture
- Quick NOTES / OBSERVATIONS
- Open Platform drill-down without leaving situational awareness longer than needed

### Does **not** belong in Mission

- Param bulk editing
- Agent coding sessions
- Release / deploy authoring
- SITL experiment controls presented as live aircraft truth
- Dense companion policy editors

**Parity policy:** Mission may be **less capable** than Mission Planner. That is intentional.

---

## 7. PLATFORM

### Purpose

**Capability-centric** engineering surface for understanding and configuring the aircraft system.

### Primary user

Engineer/operator investigating, tuning, diagnosing, reviewing history.

### Primary structure

Platform hosts capability modules, for example:

- Vision  
- Landing  
- Navigation  
- Video  
- Companion  
- Configuration  
- Diagnostics  
- Debrief  

Do **not** blindly preserve current top-level tabs. Current Parameter Center, Telemetry dash, Maintenance health, and Debrief/logs fold into Platform modules over migration.

### Primary information

- Per-capability state, diagnostics, configuration, related history hooks
- Cross-links into Evolve when an observation becomes IDEA/REQUEST/BUG/…

### Primary actions

- READ_ONLY inspection
- CONFIG_CHANGE (explicit approval)
- NOTE / REQUEST capture
- Navigate to Debrief evidence
- Companion maintenance actions that are not Evolve release authoring (still gated)

### Does **not** belong in Platform

- Full Evolve pipeline UI (tasks/agent/tests/release/deploy boards)
- Flight PFD as the main canvas
- Chat-only AI products as peer “capabilities”

---

## 8. EVOLVE

### Purpose

Turn ideas and requests into **verified, deployed** product change — with evidence.

### Pipeline (locked)

```
Idea / Request
  → Development Task
  → Worktree
  → Cursor Agent (implementation engine)
  → Tests
  → Review
  → Release
  → Deploy
  → Verification
```

The **Agent is an implementation engine, not the product.** Evolve must not collapse into a generic chat UI.

### Primary user

The same primary engineer driving change velocity.

### Primary information (must be visible)

- **What** is being changed  
- **Why** (originating IDEA/REQUEST/BUG/… + linked observation/flight if any)  
- **Affected capabilities**  
- Current pipeline **state**  
- Concrete **changes** (diff / file impact — conceptual; implementation later)  
- **Tests** and outcomes  
- **Release** contents  
- **Deployment** evidence (claimed vs verified running version)  

### Primary actions

- Create/classify task (IDEA … FEATURE)  
- Start/cancel agent (policy-gated)  
- Run approved test profiles  
- Approve → create release → deploy (each step explicit)  
- Verify post-deploy  
- Rollback (dangerous; explicit)  

### Does **not** belong in Evolve

- Live PFD / map flying UI  
- SITL as production truth  
- Unscoped free-form “fix production from chat” without task/worktree  
- Personal CUSTOMIZE layout editing presented as DEVELOP  

### CUSTOMIZE vs DEVELOP (locked)

| Path | Changes | Persistence | Approval |
|------|---------|-------------|----------|
| **CUSTOMIZE** | Layout, visibility, density, Assist posture | User preference store | Usually UI_ACTION / none |
| **DEVELOP** | Product code, APIs, capability modules | Git worktree → release | CODE_CHANGE + DEPLOYMENT |

---

## 9. LAB

### Purpose

**Simulation and experiment** space: SITL, controlled replays, development-only tools.

### Primary user

Engineer rehearsing or validating without claiming production aircraft state.

### Primary information

- SITL connection and simulation state  
- Experiment controls clearly labeled **non-production**  
- Links to Evolve experiments  

### Primary actions

- Start/stop simulation  
- Replay / scenario tools  
- Param experiments **in sim** (still CONFIG_CHANGE policy; never silently write live FC)  

### Does **not** belong in LAB

- Anything that **implies** the real aircraft is in that state  
- Production deploy buttons  
- Hiding the LAB/production boundary in copy or chrome  

**Hard rule:** LAB capabilities must not be presentable as aircraft production truth.

---

## 10. ASSIST

### Placement (locked)

ASSIST is a **persistent / launchable interaction layer** available from all major workspaces. It is **not** a sixth peer tab in the primary IA.

**C10.2:** Right-side Assist rail (`#assistRail`) with text input. Advisor / מהנדס tabs remain until later merge; Assist does not replace them yet.

Suggested presentation (implementation later): rail, drawer, or compact composer — always bound to current context.

### Channels

- Text  
- Voice (STT → intent → policy → answer/action → TTS / ElevenLabs)  

UI remains primary (~70%). During Mission with hands on RC, voice share may rise without changing the overall product bet.

### Intent vocabulary (locked)

| Intent | Typical outcome |
|--------|-----------------|
| **QUESTION** | Explanation / state answer |
| **OBSERVATION** | Structured note + optional attention item |
| **NOTE** | Flight/engineering note |
| **REQUEST** | Evolve candidate (IDEA/REQUEST/…) |
| **DEVELOPMENT** | Task / agent-oriented follow-up (still approval-gated for code) |
| **OPERATIONAL_ACTION** | Policy-gated ops action |

Same context layer powers Mission questions, Platform questions, Evolve questions, notes, and future voice.

### Proactive voice — **policy only** (do not implement in C10.1)

**Attention Policy** levels:

| Level | Meaning | Default voice posture (future) |
|-------|---------|--------------------------------|
| **INFO** | FYI; no interruption | Silent unless user asks / Assist open |
| **ATTENTION** | Should notice soon | Optional chime / Assist badge; spoken only if user enables proactive mid |
| **CRITICAL** | Safety / loss of link / hard fail | May speak if user enables proactive high; never unbounded chatter |

User must control how proactive AIRVIX is. Default posture: **quiet**. The product must avoid an assistant that constantly talks.

---

## 11. Context contract

Future Assist receives a **Context Object**. C10.1 defines categories and ownership only — **no storage implementation**.

| Category | Contents (conceptual) | Owner (source of truth) |
|----------|----------------------|-------------------------|
| `current_user` | Single primary user identity/prefs | Auth / local profile (future) |
| `current_workspace` | PULSE \| MISSION \| PLATFORM \| EVOLVE \| LAB | UI shell |
| `current_capability` | Active Platform capability id or null | UI shell / registry |
| `current_ui_state` | Selection, filters, open drawers | UI shell |
| `current_mission` | Mission mode flags, map focus | Mission workspace |
| `current_flight` | Flight id / session if any | Flight / debrief stores |
| `aircraft_state` | Mode, armed, link, selected sensors | MAVLink / telemetry services |
| `recent_events` | Bounded recent events | Event / log services |
| `recent_notes` | Bounded notes/observations | Notes store (future unified) |
| `active_development_task` | Open Evolve task + agent snapshot | Development task store / agent registry |
| `recent_releases` | Recent release metadata | Release store |
| `recent_deployments` | Recent deploy attempts + evidence | Release / companion deploy status |
| `available_actions` | Actions legal in this context | Policy + capability registry |
| `policy_state` | Confirmations required, inflight locks | Server policy modules |
| `historical_context` | Retrieved memory hits (future) | Long-term memory service (§13) |

**Rules:**

- Context is **assembled at request time** from owners — Assist does not own aircraft truth.  
- Secrets (API keys, credentials) **never** enter context payloads, logs, or prompts.  
- Historical context is **retrieval**, not “entire chat dump.”

---

## 12. Approval contract

AIRVIX must **never autonomously implement** a proposed solution for consequential change. Flow: **SUGGEST → USER APPROVES → APPLY → VERIFY**.

### Action categories

| Category | Examples | Explicit confirmation | Authorization owner | Verification |
|----------|----------|----------------------|---------------------|--------------|
| **READ_ONLY** | Telemetry view, explain state, open module | No | N/A | Display matches source; no mutation |
| **UI_ACTION** | Switch workspace, expand panel, snooze INFO, CUSTOMIZE layout | No (unless destructive UI wipe) | User preference / UI | UI state reflects action |
| **NOTE** | Save observation / flight note | Soft confirm optional; default allow | Notes store | Note persisted and listed |
| **CONFIG_CHANGE** | Param write, policy edit, companion config | **Yes** | Server param/policy gates | Read-back / audit entry |
| **FLIGHT_ACTION** | Mode change, guided command, arm-related | **Yes** (strict) | Flight policy / FC safety | Telemetry evidence of command effect |
| **CODE_CHANGE** | Agent start that edits worktree; merge intent | **Yes** (start + review gates) | Evolve task + agent bridge | Diff + tests + review state |
| **DEPLOYMENT** | Deploy release, rollback | **Yes** (strict) | Release service + companion | Running version / health evidence — **never trust click alone** |

### Non-destructive UI without explicit approval

Allowed when appropriate: navigation, view toggles, opening Assist, capturing drafts that are not yet persisted as consequential records, snoozing non-critical attention, CUSTOMIZE preferences.

**Not** allowed without approval: anything in CONFIG_CHANGE, FLIGHT_ACTION, CODE_CHANGE, DEPLOYMENT — and any NOTE that the product later treats as an automatic CODE_CHANGE trigger (notes may *spawn* a draft IDEA; they must not auto-start the agent).

---

## 13. Long-term memory contract

**Goal:** contextual continuity across engineering/operations — **not** chat history as the product.

### Remember (eventually, where appropriate)

Flights · events · observations · notes · ideas · development tasks · agent sessions · tests · releases · deployments · rollbacks · decisions  

### Continuity chain (target query shape)

```
flight → observation → task → code change → test → release → operational result
```

Example future query: *“What did we try last time to improve landing confidence?”*  
Expected: retrieve linked observation → Evolve task → release → post-deploy outcome — not a random chat snippet.

### Contract rules (C10.1 — define only)

| Rule | Statement |
|------|-----------|
| Memory ≠ chat log | Chat is an interface; memory is structured links between domain objects |
| Provenance | Every memory hit cites object ids (flight, task, release, …) |
| No secrets | Never store API keys, credentials, raw env |
| Bounded retrieval | Assist gets ranked excerpts, not unbounded dumps |
| User-visible | User can inspect what was remembered / linked (future UI) |

**Do not implement** the memory system in C10.1.

---

## 14. Current UI mapping

Critical stance: the current tab inventory is a **tool shelf**, not the target IA. Mapping guides migration — it does not freeze today’s chrome.

| Current surface | Verdict | Target disposition |
|-----------------|---------|-------------------|
| Parameter Center (`#control`) as default home | **RESTRUCTURE** | Platform → Configuration; demote from home |
| Landing / Abort / Vision Nav param subpanels | **REFINE** | Stay under Configuration + capability hooks (landing/vision/navigation) |
| Auto-Config wizard | **MERGE** | Assist + Configuration (suggest → approve → apply) |
| Custom params / ArduLab output sink | **REFINE** | Configuration + Evolve/ArduLab path |
| Telemetry dash (`#telemetry`) | **MERGE** | Pulse (compressed) + Platform diagnostics / companion |
| Companion B2 / policy editor in telemetry | **RESTRUCTURE** | Platform → Companion (+ Diagnostics) |
| Jetson install/rollback under telemetry | **MERGE** | Platform → Companion (gated); version truth ≠ Evolve release board |
| Preflight card (telemetry) / SITL preflight / PFD readiness | **MERGE** | Single readiness concept; Mission glance + Diagnostics |
| Topbar mini-HUD | **KEEP** / **REFINE** | Global glanceables; single source of truth |
| הטסה PFD + map (`#terrain`) | **REFINE** | Mission workspace |
| תחקור recordings | **MERGE** | Platform → Debrief |
| Hidden `#flights` logs hub | **MERGE** / **REMOVE** as peer tab | Platform → Debrief (one entry) |
| Maintenance release/rollback/backups | **RESTRUCTURE** | Evolve owns release/deploy; Platform keeps health/backups as needed |
| Maintenance title “פיתוח ותחזוקה” | **REMOVE** naming | Avoid collision with Evolve |
| Development Tasks (`#development`) | **RESTRUCTURE** | Evolve workspace (evidence-first, not chat-first) |
| AI Advisor (`#advisor`) | **MERGE** | Assist layer |
| מהנדס טיסה (`#flightEngineer`) | **MERGE** | Assist layer (flight-safe posture in Mission) |
| ArduLab (`#featureDesigner`) | **REFINE** | Evolve specialist path and/or Platform capability — not peer Assist tab |
| SITL Lab (`#simLab`) | **KEEP** / **REFINE** | LAB; reduce connection UX duplication with topbar |
| Orphan `#processes` | **REMOVE** | Dead DOM |
| Version modal / changelog | **KEEP** | Console product version chrome |
| ElevenLabs / STT / TTS hooks | **KEEP** / **REFINE** | Voice capability plumbing for Assist |
| Global settings (voice, volume) | **REFINE** | CUSTOMIZE + Voice policy controls (incl. future proactivity) |
| Connect widget | **KEEP** / **REFINE** | Global; LAB must not fork a second “truth” |

### KEEP (assets)

PFD/map bones · SITL core · param read/write/smart search depth · Evolve pipeline spine (task/worktree/agent/test/release) · companion contract · voice plumbing · audit/apply confirmation patterns · topbar glanceables.

### REMOVE / absorb

Peer AI tabs as equals · orphan processes · hidden flights as separate IA · Parameter Center as home · Maintenance as second Evolve · dashboard-as-inventory thinking.

### REDESIGN (next waves)

Pulse home · Assist unification · Evolve evidence UI · Platform capability shells · single Debrief · single release ownership · Attention Policy UX.

---

## 15. Migration principles

1. **Fold, don’t cliff-delete** — move jobs into Pulse/Mission/Platform/Evolve/Lab/Assist without stranding working features overnight.  
2. **Backend stays authoritative** — policy gates, MAVLink, companion API, agent bridge, release store, audit remain infrastructure; IA moves around them.  
3. **No silent behavior change** — C10.1 does not change Jetson, FC, Agent bridge, Release/Deploy, or flight command semantics.  
4. **One owner per job** — especially release/deploy and Assist.  
5. **Evidence over ceremony** — every APPLY/DEPLOY path must define VERIFY.  
6. **CUSTOMIZE ≠ DEVELOP** — never let layout prefs write product code.  
7. **LAB boundary sacred** — simulation never presented as production aircraft state.  
8. **Quiet by default** — proactive voice is opt-in policy later; never ship a talkative default.

---

## 16. Next implementation phase

### C10.2 — Assist unification (landed)

Thin vertical Assist foundation:

- Server: `lib/assist/*` + `POST /api/assist/message` + `POST /api/assist/confirm`
- Deterministic intents: QUESTION / OBSERVATION / NOTE / REQUEST / DEVELOPMENT / UI_ACTION (no FLIGHT_ACTION)
- Safe actions only: UI_NAVIGATION (known routes), CREATE_NOTE, CREATE_OBSERVATION, CREATE_DEVELOPMENT_TASK (confirm)
- Confirmed CREATE_DEVELOPMENT_TASK composes isolated worktree + existing coding-agent start (not a new proposed action). No merge/deploy/FC/companion apply.
- Assist returns Hebrew run status and polls until a terminal agent state (or shows the Hebrew unavailable reason).
- Persistent Assist rail UI (not a peer tab / not full-page chat)
- Today’s tabs map into workspace labels until Pulse/Mission/… shells ship
- Text channel only; voice uses the same pipeline later
- Session history only — no long-term memory

### Then

| Phase | Focus |
|-------|--------|
| **C10.3** | Pulse home (non-breaking prototype / localStorage home pref) |
| **C10.4** | Evolve workspace v2 (taxonomy + evidence + absorb release owner) |
| **C10.5** | Platform capability shells + Debrief merge |
| **C10.6** | Mission flight-safe Assist polish |
| **C10.7** | Voice layer + Attention Policy controls |
| **Later** | Long-term memory retrieval along the continuity chain |

### Explicitly **out** of C10.1 / still deferred past C10.2

Full IA chrome rewrite · peer Assist tab · STT/ElevenLabs Assist path · Jetson/FC/Agent/Release behavior changes · FLIGHT_ACTION · long-term memory.

---

## Document control

| Field | Value |
|-------|-------|
| Created | C10.1 |
| Companion review canvas | `canvases/airvix-c10-product-architecture.canvas.tsx` (C10 opinionated review) |
| Implementation status | C10.1 contract + C10.2 Assist foundation + C10.3 Pulse home prototype |

**Next:** C10.4 Evolve workspace v2.

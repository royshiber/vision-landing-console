# AIRVIX Jetson Flight Skills — Living Architecture

Living architecture. Not a release note. Not a claim that custom skills already fly.

**Decision (2026-09-13):** Roy locked `arch_jetson_skills`. This revision is the architecture contract only. No skill runtime, no wing-rock code, no `SET_MODE` for a custom maneuver.

Hebrew operator companion: [`JETSON_FLIGHT_SKILLS.he.md`](./JETSON_FLIGHT_SKILLS.he.md).

Repo language for this file is English. Product UI stays Hebrew RTL.

---

## How to read this file

| This document | Is not |
|---|---|
| The locked split: Ask (console) vs Jetson Companion vs Flight Controller | A license to send ARM, DISARM, LAND, `SET_MODE`, or auto-land |
| The skill lifecycle: propose → GO session → run → abort | A wing-rock implementation |
| Hard limits, timeout, and RC-override abort for **custom** skills | A new native ArduPilot mode |
| What belongs on Jetson vs FC vs console | Companion apply / restart, or a live-vehicle GO |

Update this file when the **architecture meaning** of voice / special flight skills changes. Do not invent a `STATUS.md`. Constitution and work-rules stay in `AGENTS.md`.

Related:

- [`PRODUCT_EXECUTION.md`](./PRODUCT_EXECUTION.md) — living execution map; Issue #29 still holds
- [`AIRVIX_PRODUCT_ARCHITECTURE.md`](./AIRVIX_PRODUCT_ARCHITECTURE.md) — Ask / Assist intent layer (`FLIGHT_ACTION` stays gated)
- [`VISION_LANDING_PRODUCT.md`](./VISION_LANDING_PRODUCT.md) — vision landing is a **separate** product path
- [`JETSON_AGENT.md`](./JETSON_AGENT.md) — Companion relay and observe-only UART today
- [`CELLULAR_FULL_OPS.md`](./CELLULAR_FULL_OPS.md) — Companion-HTTP is **not** the FC command path
- [`ADVISOR_SAFETY.md`](./ADVISOR_SAFETY.md) — advisor / Ask must never become a silent FC writer

---

## 1. Locked split (three layers)

Do not collapse these layers. Do not let one layer impersonate another.

| Layer | Role | Owns | Must never |
|---|---|---|---|
| **Ask (console)** | Free-form NLU / intent — voice or text | Hear / parse / propose a skill card; hold a GO session; show run / abort state | Execute a maneuver; invent ARM; treat a spoken yes as ARM / DISARM / LAND |
| **Jetson Companion** | Skill **executor** for custom maneuvers that are **not** native ArduPilot modes | Sequenced, limited MAVLink setpoints / commands after an approved GO session | Replace the FC inner loop; invent ARM; own RTL / LAND / FBWA as a “skill” |
| **Flight Controller** | Inner-loop stability | Attitude / rate / airspeed loops; native flight modes | Be bypassed; run a custom sequence the Jetson invented without limits |

```
voice or text
  → Ask (console): intent only
      → native mode (RTL, LAND, FBWA, …): console → FC MAVLink, as today
      → custom skill (example: wing rock): Ask → Jetson → MAVLink setpoints / sequenced commands
  → Flight Controller: always the inner loop
```

Companion real still requires **both** `COMPANION_MODE=real` **and** a non-empty Companion URL. A URL alone must never enable real. That gate is already on master. It is not permission to touch a live vehicle, apply, or restart.

Companion-HTTP is **not** the flight-command path to the FC. Custom skills, when later implemented, leave the Jetson as a MAVLink executor toward the FC — not a console HTTP shortcut around the inner loop.

---

## 2. Native modes vs custom skills

### 2.1 Native ArduPilot modes (stay on the existing path)

Modes the FC already knows — RTL, LAND, FBWA, AUTO, LOITER, and the rest of the plane mode set — **may remain console → FC MAVLink as today**.

That path is unchanged by this lock:

- The console may continue to display mode and (when a later Human Gate GO exists) send `SET_MODE` for a **named native mode**.
- Ask must not silently `SET_MODE` because a phrase sounded like a mode.
- Issue #29 still covers any **send** of ARM / DISARM / LAND / `SET_MODE` / live FC write / auto-land.

A native mode is **not** a Jetson skill. Do not wrap RTL or LAND as a Companion “skill” to dodge the console → FC path or the flight-command gate.

### 2.2 Custom skills (Jetson executor)

A **custom skill** is a maneuver the FC does **not** already own as a mode. The locked example is **wing rock**: sequenced, limited bank left, then right — not an ArduPilot mode, not a `SET_MODE` target.

Intended path (future implementation, not this revision):

```
Ask intent
  → visible skill card
  → operator GO session
  → Jetson Companion skill executor
  → MAVLink setpoints / sequenced commands
  → Flight Controller inner loop
```

Every custom skill must carry, on the Jetson executor:

- **Hard limits** (example: max bank angle).
- **Timeout** (the sequence dies when time is up).
- **RC-override abort** (any PIC stick takeover kills the skill immediately).

This revision **documents** that shape. It does **not** implement wing rock, does **not** add a `SET_MODE` alias for wing rock, and does **not** add skill HTTP or MAVLink writers.

---

## 3. Skill lifecycle

Locked product sequence. A later implementation must not skip a box.

```
propose → GO session → run → abort
```

### 3.1 Propose

Ask (voice or text) maps free-form speech / type to a **named intent**.

- Output is a **visible card**: skill name, what it will do in one line, limits, timeout, abort rule.
- Propose is **not** run. No MAVLink setpoints. No mode change.
- Unknown or unsafe phrasing stays a question or a refuse — not a hidden command.
- ARM / DISARM / LAND / auto-land / native `SET_MODE` stay **blocked at Ask**. A spoken “yes” may confirm only a card that is already on screen.

### 3.2 GO session

A custom skill starts only inside an explicit **GO session**.

- The operator confirms a named skill on a control that cannot be mistaken for “dismiss” or “ok thanks.”
- The session is bounded: this skill, these limits, this timeout, this abort.
- The session is **not** a blanket license for Ask to send flight commands.
- The session is **not** Companion apply / restart.
- The session does **not** invent ARM. If the aircraft is not already armed by a path this constitution already allows, the skill **refuses**.

Until a later Human Gate opens a specific skill to a live vehicle, the UI must keep showing that custom-skill **run** is not approved to fly. Hiding the block is a safety bug.

### 3.3 Run

Only after GO, and only for that session:

- Jetson executes the sequence (setpoints / timed commands) with hard limits.
- The FC remains the inner loop. The Jetson does not write raw actuators around ArduPilot.
- The console shows run state (active / remaining time / last abort reason). Display is not authority.
- Ask may talk about the run. Talk is not a second command path.

### 3.4 Abort

Abort is first-class. Any of these **kills the skill immediately**:

| Abort | Meaning |
|---|---|
| **Operator abort** | Visible cancel on the card / Ask. Ends the session |
| **RC override** | PIC moves the stick / takes override. Skill dies; FC / RC has the airplane |
| **Timeout** | Hard max time. Sequence stops even if “almost done” |
| **Limit hit** | Max bank (or other published envelope) reached or exceeded. Stop, do not push through |
| **Link / heartbeat loss** | Companion or FC heartbeat stale. Stop sending skill setpoints |
| **GO withdrawn** | Session closed. No leftover sequence |

On abort: stop the sequence, restore a documented safe residual (typically the mode the FC already had — **not** an invented LAND or DISARM), and say so in the UI. Do not keep banking “because we already started.”

---

## 4. Safety — standing rules

This file does not relax `AGENTS.md`, Issue #28, or Issue #29.

- **ARM / DISARM stay blocked at Ask.** Voice and text never arm. Skills never invent ARM. A skill that “needs armed” refuses when disarmed; it does not arm to help itself.
- **Skills never invent LAND, auto-land, or DISARM** as a side effect of finishing or aborting.
- **Max bank and max time are hard.** They live on the Jetson executor, not only as UI copy. Soft “please don’t exceed” is not enough.
- **RC override kills the skill.** The PIC is not competing with a script. Stick / override wins on the first sample that counts as override.
- **The FC inner loop is never bypassed.** No direct servo hijack, no “ignore ArduPilot for a second,” no custom skill that is actually a hidden `SET_MODE`.
- **Native modes stay native.** RTL / LAND / FBWA are not re-hosted as Jetson skills.
- **Companion BOTH gate stays.** Real Companion needs mode **and** URL. Unrelated to a skill GO.
- **No silent FC write from NLU.** Ask proposes. The operator GO’s. The Jetson runs a bounded script. The advisor / LLM is not a writer.
- **Cloud Agent VMs** stay localhost / mock. No network to a Jetson, FC, or production vehicle. No secrets, tokens, or Jetson addresses in this file, a prompt, a PR, or logs.
- **This document is not a flight-command GO.** Merging it is ordinary docs.

---

## 5. What belongs where

| Concern | Console / Ask | Jetson Companion | Flight Controller |
|---|---|---|---|
| Free-form voice / text, NLU, intent | **Yes** | No | No |
| Skill card, GO session, abort UI | **Yes** | Reports state only | No |
| Native mode send (when a later GO exists) | Existing MAVLink path | Must not steal the mode | Executes the mode |
| Custom sequence (bank left / right, timed steps) | Must not sequence MAVLink itself | **Yes** — executor | Tracks setpoints; inner loop |
| Hard limits, timeout, RC-override watch | Shows the contract | **Enforces** the contract | Stability + RC authority |
| ARM / DISARM | **Blocked** | Never invent | Only existing gated paths |
| Inner-loop stability | Display only | Must not replace | **Always** |
| Companion apply / restart | Human Gate #28 — not a skill | Install is not a maneuver | N/A |
| Vision landing detect / lock / later assist-steer | Separate product doc | Observe / later gated vision path | Classic LAND remains the legal land today |

Rule of thumb:

- If ArduPilot already has a **mode**, the console talks to the FC.
- If the maneuver is a **sequence the FC does not own**, Ask proposes and the Jetson executes under limits.
- If it is **stability**, it stays on the FC.

---

## 6. Example — wing rock (documentation only)

Product meaning, so later work does not invent a mode:

- **Wing rock** = a short, sequenced, **limited** bank left, then right (then recover), to show or test roll authority / visibility.
- It is **not** an ArduPilot mode. There is no honest `SET_MODE` for wing rock.
- It is the canonical **custom skill**: Ask names it → GO session → Jetson sends limited setpoints → FC flies the inner loop → timeout / RC override / operator abort ends it.
- **This revision does not implement it.** No skill script, no Companion route, no setpoint writer, no console button that pretends the skill exists.

A later implementation PR must restate limits (max bank, max time) and keep ARM blocked at Ask. That PR is a new Human Gate if it can run against a live vehicle.

---

## 7. Phase 0 non-goals (this document)

Phase 0 is **these files**. It does not implement.

- No Jetson skill runtime, no wing-rock code, no sequenced bank writer.
- No `SET_MODE` invented for wing rock or any other custom skill.
- No Ask unlock of ARM / DISARM / LAND / auto-land / native `SET_MODE`.
- No new Companion real path, apply, or restart.
- No secrets, tokens, or host addresses.
- No rewrite of vision landing. Vision landing stays [`VISION_LANDING_PRODUCT.md`](./VISION_LANDING_PRODUCT.md).
- No Cloud Agent contact with a live vehicle.

---

## 8. Decision log

| Date | Decision | Meaning |
|---|---|---|
| 2026-09-13 | `arch_jetson_skills` | Ask = NLU / intent. Jetson = custom-skill executor. FC = inner loop, never bypassed. Native modes may stay console → FC. Custom skills: Ask → Jetson → limited setpoints, timeout, RC abort. Docs only in that change |
| Existing | Companion BOTH gate | Real Companion needs mode **and** URL. Not a skill GO |
| Existing | Issue #28 / #29 | Apply/restart and flight-command **send** stay WAITING FOR ROY |

When Roy opens a specific skill to implement or to fly, add a row here with the outcome in simple product language.

---

## 9. Maintenance

- English file = source for engineers and the repo.
- Hebrew companion = operator reading, short, no implementation talk.
- If the layer split, the lifecycle, or a safety line changes, update **both** files in the same change.
- Do not list custom skills as a shipped commercial capability until a skill actually exists on master **and** is honest.

This document may stay ahead of the code. The code must not stay ahead of this document’s safety lines.

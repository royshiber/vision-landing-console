# AIRVIX Vision Landing — Living Product Vision

Living product document. Not a release note. Not a claim that the capability already ships.

**Decision (2026-09-13):** Roy chose `vision_doc_only`. This revision is the full product document first. No flight, control, Companion, or camera implementation in the same change.

Hebrew operator companion: [`VISION_LANDING_PRODUCT.he.md`](./VISION_LANDING_PRODUCT.he.md).

Repo language for this file is English. Product UI stays Hebrew RTL.

---

## How to read this file

| This document | Is not |
|---|---|
| The intended product path from classic mission LAND to vision-based landing | A license to send ARM, LAND, SET_MODE, or auto-land |
| The capability ladder, UX, and named Human Gates | A Jetson apply / restart plan |
| The experiment sequence Exp#1 → Exp#4 | Proof that any later experiment is approved to fly |

Update this file when the **product meaning** of vision landing changes. Do not treat a UI polish pass as a reason to rewrite it. Do not invent a `STATUS.md`. Constitution and work-rules stay in `AGENTS.md`.

Related:

- [`PRODUCT_EXECUTION.md`](./PRODUCT_EXECUTION.md) — living execution map
- [`AIRVIX_PRODUCT_ARCHITECTURE.md`](./AIRVIX_PRODUCT_ARCHITECTURE.md) — `vision` / `landing` / `precision_landing` capability homes
- [`JETSON_CAMERAS.md`](./JETSON_CAMERAS.md) — dual-camera ingest honesty
- [`CELLULAR_FULL_OPS.md`](./CELLULAR_FULL_OPS.md) — annotated video is cellular-only
- [`TELEMETRY_ARCHIVE.md`](./TELEMETRY_ARCHIVE.md) — operator-armed recording
- [`ADVISOR_SAFETY.md`](./ADVISOR_SAFETY.md) — advisor must never become a silent FC writer
- [`JETSON_FLIGHT_SKILLS.md`](./JETSON_FLIGHT_SKILLS.md) — custom flight skills (Ask → Jetson); not this vision-landing path
- [`COMMERCIAL_CAPABILITIES.he.md`](./COMMERCIAL_CAPABILITIES.he.md) — outbound commercial summary; do not list unbuilt vision-land as shipped

---

## 1. Why this exists

Classic ArduPilot landing is a **mission geometry** problem: fly the plan, then the last waypoint is LAND. The aircraft goes to a coordinate. It does not need to *see* a strip, a centerline, a car, or wet grass.

AIRVIX is named for vision landing. The north star includes **full automatic landing**. That is not the same as “last waypoint LAND.” Vision landing means the aircraft (and the operator) can:

1. See a usable surface.
2. Know whether it is safe enough to use.
3. Keep or refuse the attempt with honesty.
4. Later, only after explicit Human Gates, share or take the land.

This document is the product path. It is written so Roy can read it without opening code.

---

## 2. Today — honest baseline

What is true on current `master` (observe and display). Nothing below is a control path.

### 2.1 Classic mission LAND (already the operational default)

- The aircraft can still land the way every ArduPilot plane lands: **mission + final LAND waypoint**.
- That path is GPS / mission / flight-controller logic. It is **not** vision-based landing.
- AIRVIX Mission can overlay waypoints and show flight state. Overlay is not “the camera is flying the plane.”

### 2.2 Experiment #1 — observe only

Locked Exp#1 meaning (already on master, display only):

- Fixed-wing final.
- **Pilot in command hand-flies** to final.
- The console **observes**. It does not steer, does not ARM, does not LAND, does not switch nav source.
- **Success** = runway **detect** on final.
- Video annotations are **not** required for Exp#1 success.
- Runway **lock** to the ground station is **observe-only** and is **not** required for Exp#1 success.
- A healthy Aruco / marker landing-target is **not** runway detection.

### 2.3 What the console already shows (honesty, not control)

| Surface | Honest meaning today |
|---|---|
| מוכנות / field checklist | Companion reachability, FC heartbeat, cameras (absent / dry-run / live), runway detect, lock, PLND profile keys, annotated video, telemetry archive, Ask GO, **blocked** ARM / LAND / live nav switch |
| Map lock chip | Green locked / amber searching / red no-lock — **display**. Missing lock signal stays **unknown**. Never invent lock |
| Dual cameras | CAM1 forward, CAM2 down. Operator “I did this” is not `camera_ok` |
| Annotated video | Cellular only. Radio up does not unlock video. No stream → `stream_absent` / `modem_absent`, not a fake picture |
| Optical nav | Estimator off. Position null. Not fused. Not a nav source |
| PLND / vision-nav keys | Present / missing / unknown from a real read. Profile does **not** block Exp#1 |
| Recording | Operator-armed archive. Connect alone does not start a debrief file |
| Flight-command gate | Closed. Tokens ARM / LAND / auto-land stay unsent from this path |

Companion real still requires **both** `COMPANION_MODE=real` **and** a non-empty Companion URL. A URL alone must never enable real. That gate is already on master. It is not permission to touch a live vehicle.

---

## 3. Destination (what “vision landing” means)

The operator should be able to treat a strip as a **seen, judged, chosen surface**, not only a last waypoint.

End state (future, not this revision):

- The system detects a runway-shaped surface in the cameras.
- It can hold a **centerline** belief with an honest confidence.
- It can say “not clear” when cars, people, or debris are in the way.
- It can propose **candidate** strips (map + vision), never silently pick one.
- Roy can define **runway profiles** (surface, min width, min length, wind).
- The map lock is an obvious green / red contract the operator trusts.
- Ask voice can answer landing questions in the air.
- Later: **gated assist-steer** (Human Gate).
- Later still: **full auto vision land** only with an explicit Human Gate GO.

Until those gates exist and Roy says GO, the aircraft lands the classic way, or the PIC flies the final by hand.

---

## 4. Capability ladder

Climb in order. Do not skip a rung into control.

| Rung | Capability | Product meaning | Control? |
|---|---|---|---|
| 0 | Classic mission LAND | Last waypoint LAND. Always available. Not vision | Existing FC mission path — not this vision product |
| 1 | Detect runway | “I see a strip on final.” Exp#1 success | Observe only |
| 2 | Centerline | “I see the line to track.” Confidence and offset are visible | Observe, then advise |
| 3 | Obstacles | Cars, people, obvious foreign objects on or near the strip | Observe, then advise refuse |
| 4 | Candidate runways | Find other plausible strips in view or on the map | Propose only |
| 5 | Runway profiles | Named sites: asphalt / concrete / dirt / grass, min width, min length, wind | Config + refuse if unfit |
| 6 | Map pick | Operator taps / confirms the site. System may highlight, not commit | Roy confirm required |
| 7 | Voice queries | Ask what the cameras and profile think | Speech in, advice out |
| 8 | Assist-steer | Limited lateral / energy help while PIC remains in command | **Human Gate** (Exp#3) |
| 9 | Full auto vision land | Vision owns the land after an explicit GO | **Human Gate** (Exp#4). Never silent |

Rules for the ladder:

- A higher rung may **display** earlier, but may not **act** earlier.
- “We detected a nicer strip to the left” is a proposal. It is not a site change.
- Profiles exist to **refuse** (too short, wrong surface, wind out of limits), not to dare a landing.
- Assist-steer and full auto are not “the next commit.” They are named experiments with gates.

---

## 5. UX the operator should feel

The UX is a **trust contract**, not chrome.

### 5.1 Readiness checklist (מוכנות)

One list, same meaning on Pulse and Mission:

- Links the field actually needs (radio required for Exp#1; cellular / home / RC honest when present).
- Cameras: absent, dry-run, or live — never a green empty circle.
- Companion reachable or not. Mock labeled as mock.
- FC heartbeat fresh or not.
- Runway detect on final: unknown / not detected / detected / absent / not implemented.
- Lock: unknown / not / detecting / locked.
- Archive ready vs actually recording.
- Ask voice session on or off.
- **Always-visible blocked rows** for ARM, LAND, and live nav-source switch until a future Human Gate GO.

If a row is unknown, say unknown. Do not paint it ready.

### 5.2 Map lock — green / red

The map is the primary landing picture.

| Color | Meaning the operator may trust |
|---|---|
| **Green lock** | Vision reports lock on the chosen / detected strip. Display (and later, a gate to act) |
| **Amber** | Searching / detecting. Not locked. Do not treat as ready |
| **Red / no-lock** | No lock, or lock lost. Not a land cue |
| **Unknown** | No lock signal at all. Worse than red: we are not even sure the detector is talking |

Lock is never inferred from GPS being near a waypoint. Lock is never inferred from a marker detector. Lock is never inferred from a healthy camera alone.

When a later experiment is allowed to act, **lost lock is abort**, not “keep going on memory.”

### 5.3 Ask — voice phrases (product, not an unlock)

Voice is for **questions and confirmations**. It is not a hidden LAND button.

Intended query phrases (Hebrew in the product UI; listed here so the contract is obvious):

- “Do you see the runway?”
- “Are we on centerline?”
- “Is the strip clear?”
- “What surface do you think this is?”
- “Is it long enough / wide enough for this profile?”
- “What is the wind doing to this choice?”
- “Show other candidate strips.”
- “Lock that one” / “Keep this one” — **confirm a pick**, not send LAND.
- “Unlock” / “lost it” — honesty, then abort rules if a gated experiment is live.

Forbidden as silent effects of speech:

- ARM
- DISARM
- LAND
- auto-land
- SET_MODE
- live nav-source switch
- “just land it” without an explicit on-screen Human Gate that names the action

A spoken “yes” may confirm a **visible** card (pick this candidate, start recording, ask again). It must not invent a flight command that was not on the card.

### 5.4 Debrief recording

A vision landing attempt that cannot be replayed is a story, not a product.

- Recording is **operator-armed** (existing archive: start / stop). Idle MAVLink must not open a file.
- Exp#1 and later field hops should make it obvious: start before the approach if you want a debrief.
- Debrief later binds: map lock timeline, detect / lock states, camera roles that actually had frames, voice queries asked, and the mission LAND waypoint the plane would have used anyway.
- No invented frames in the recording. If the annotated stream was absent, the debrief says so.

---

## 6. Safety — observe first, never silent

### 6.1 Standing rules (this document does not relax them)

- **Observe-first.** Cameras and detectors may be wrong. The PIC is not.
- **No ARM from vision.** Vision never arms the aircraft.
- **LAND-by-vision is never silent.** If a future experiment may send LAND, the operator sees a named action, a named gate, and a named abort. No background LAND because confidence flickered green.
- **Abort if lock is lost** (from the first experiment that is allowed to act). Lost lock → stop the vision land / assist, return to a safe documented behavior (PIC, go-around, or classic mission abort — chosen at that Human Gate, not invented here).
- **Unknown is not OK.** Missing camera, missing detector, missing lock signal, fog, or night with no honesty = do not climb the ladder.
- Cloud Agent VMs stay localhost / mock. No network to a Jetson, FC, or production vehicle.

### 6.2 Named Human Gates

These are already constitution / execution gates. This product does not bypass them.

| Gate | What Roy must decide | Not covered by this doc |
|---|---|---|
| Companion apply / restart (Issue #28) | Live mission-computer install, systemd, GStreamer | Docs here do not apply |
| ARM / DISARM / LAND / SET_MODE / live FC write / auto-landing (Issue #29) | Any send of those commands; any vision-owned land | Docs here do not unlock |
| Secrets / deploy to devices / flight commands | Production and live vehicles | Out of scope |
| **Exp#3 assist-steer GO** | First time vision may *help* steer | Future, explicit |
| **Exp#4 full vision-land GO** | First time vision may *own* the land | Future, explicit |
| New safety policy not already in `AGENTS.md` | Anything this file does not already state | Stop and ask |

Merging this document is ordinary docs. It is **not** a flight-command GO.

### 6.3 What “LAND-by-vision never silent” means in the UI

When (and only when) a later GO exists:

1. The action is named in Hebrew on a card: this is a vision land, not a mission last-waypoint LAND.
2. The operator confirms with a control that cannot be mistaken for “dismiss” or “ok thanks.”
3. The map lock must be green on the **confirmed** site.
4. If lock drops, the attempt aborts in the open — voice + chip + checklist — and does not keep a LAND in the air “because we already sent it” without a documented abort behavior from that GO.

Until that GO, the UI must keep showing the **blocked** row. Hiding the block is a safety bug.

---

## 7. What makes it cool — without being reckless

Cool is **judgment and honesty**, not a highlight reel that lands on a driveway.

### 7.1 Surface materials

Profiles name the surface: **asphalt, concrete, dirt, grass** (and later, only if we can be honest, wet / worn variants).

Cool: “this looks like dry grass, 12 m wide, wind from the left — your grass profile wants 18 m and less crosswind. Refuse.”

Reckless: “surface unknown, confidence 0.91, send LAND.”

### 7.2 Foreign-object detect

Cars, people, and obvious debris on the strip are first-class **refuse** reasons.

Cool: “centerline good, person at the far threshold, do not land.”

Reckless: averaging the obstacle away, or treating a parked car as texture.

Marker / Aruco detect is a different product. It must not count as “strip is clear.”

### 7.3 Short-runway refuse

Every profile has a **minimum length and width**. If the seen or mapped strip is shorter or narrower, the product **refuses**. It does not “try a firm landing.”

Cool: the map candidate turns red with a one-line reason the PIC can use.

Reckless: energy games to squeeze a too-short strip.

### 7.4 Lighting and fog honesty

Night, low sun, rain, fog, dirty lens: the system may say **degraded** or **unknown**. It may not keep a green lock on a blur.

Cool: “forward camera degraded, down camera ok, lock not trusted.”

Reckless: a single confidence number that hides which camera died.

### 7.5 Dual camera roles (already the hardware intent)

| Camera | Role | What it is for | What it is not |
|---|---|---|---|
| **CAM1 forward** | Approach | See the strip early, judge alignment, lighting, large obstacles | Not a fake HUD if the device is absent |
| **CAM2 down** | Close-in | Centerline, flare picture, surface texture, FOD near the wheels | Not optical-nav fusion until a later gated product |

Roles are complementary. One live camera does not let the UI pretend both roles are healthy. Operator install confirmation is not a detector.

---

## 8. Phase 0 non-goals (this document)

Phase 0 is **this file**. It does not implement.

Explicitly out of scope until Roy opens a later experiment:

- No flight-controller **write** from vision (no PARAM_SET, no SET_MODE, no ARM, no LAND, no nav-source switch driven by a detector).
- No **automatic site selection** without Roy confirm. Candidates may highlight. The pick is the operator’s.
- No Jetson apply / restart from this work.
- No new Companion real path.
- No unlocking of Ask phrases into flight commands.
- No claiming commercial “vision auto-land” in outbound docs.
- No Cloud Agent contact with a live vehicle.

Classic mission last-waypoint LAND remains the way the plane can land today. This document does not remove or replace that path.

---

## 9. Proposed experiments

Each experiment is a **product chapter**. A later chapter needs its own Human Gate if it can act.

### Exp#1 — Observe (current direction, already on master)

- PIC hand-flies final.
- Success: **runway detect on final**.
- Lock and annotations optional, display only.
- Checklist and map chip stay honest.
- No FC write from vision.
- No site auto-pick.

### Exp#2 — Advise (next product chapter, still no send)

- Same PIC hand-fly.
- Console may **advise**: centerline offset, clear / not clear, profile fit, candidate list, voice answers.
- Advice may say **refuse** (short, blocked, fog, wrong surface).
- Still no ARM, LAND, SET_MODE, assist-steer, or auto site commit.
- Debrief should be able to replay what was advised vs what the PIC did.

### Exp#3 — Gated assist (future GO)

- Requires an explicit Human Gate before any steer help exists in product.
- PIC remains in command.
- Assist is bounded (what axis, what authority, what abort).
- **Lost lock → abort assist.**
- LAND-by-vision still not silent and still not implied by assist.
- Implementation only after Roy GO for this chapter.

### Exp#4 — Full vision land (future GO)

- Vision may own the land **only** after an explicit Human Gate GO that names full auto.
- Never a default. Never a confidence threshold alone.
- Confirm the site, the profile, the lock, and the abort.
- Lost lock → abort the vision land in the open.
- Classic mission LAND remains the fallback story until this GO exists and is used.

There is no Exp#5 in this document. Do not invent one to skip a gate.

---

## 10. Decision log

| Date | Decision | Meaning |
|---|---|---|
| 2026-09-13 | `vision_doc_only` | Write the living product vision first. No implementation in that change |
| 2026-08-25 | Companion BOTH gate on master | Real Companion needs mode **and** URL. Unrelated to landing GO |
| Existing | Issue #28 / #29 | Apply/restart and flight commands stay WAITING FOR ROY |

When Roy opens Exp#2 / #3 / #4, add a row here with the outcome in simple product language.

---

## 11. Maintenance

- English file = source for engineers and the repo.
- Hebrew companion = operator reading, short, no implementation talk.
- If the ladder, a gate, or a non-goal changes, update **both** files in the same change.
- Do not bump this into a commercial capability until the rung actually exists on master **and** is honest.

This document may stay ahead of the code. The code must not stay ahead of this document’s safety lines.

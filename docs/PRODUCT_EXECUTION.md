# Product Execution Map

Living PM snapshot for Vision Landing Console. Not a frozen checklist. Not the GitHub backlog.

**Owner:** King (PM + Technical Lead + Project Manager). Cloud Agents implement; they do not own the plan.

**Language:** English. This file is the execution map. Product UI remains Hebrew RTL.

**Do not invent** `STATUS.md`. Constitution / work-rules live in `AGENTS.md`. Do not edit that file from this map.

---

## Destination

Self-evolving console. The agent is part of the product, not a sidecar IDE.

Locked loop:

```
User
  → Product UI (AIRVIX Ask or Develop chat)
  → clarifying MCQ + free text
  → Agent API
  → Cursor Agent on isolated branch
  → live UI preview
  → Human Gates (Jetson upload / FC install) — never auto-apply
  → parameters surfaced in Parameters tab
  → result back to Product UI
```

Also the product: full flight ops, full params, full Jetson UI control, full auto landing.

Related architecture (docs only, 2026-09-13): custom flight skills live in [`docs/JETSON_FLIGHT_SKILLS.md`](./JETSON_FLIGHT_SKILLS.md). Ask is NLU; Jetson executes non-native maneuvers; FC stays inner-loop. Not a flight-command GO.

Measure by **capabilities closed** and **distance to vision**, not PR count.

---

## How to update

After every meaningful VERIFY: inspect master → rewrite this snapshot → pick one next GAP → execute on an isolated branch. Stay draft until King merges a verified safe draft, or a hard safety Human Gate still holds.

---

## Classification

| Class | Meaning | Default |
|---|---|---|
| **GAP** | Capability the destination requires and the product does not yet have | Highest |
| **BUG** | Something that should already work is wrong | After blocking GAPS |
| **IMPROVEMENT** | Polish, copy, chrome | Last while major GAPS remain |

---

## Human Gates

Stay **WAITING FOR ROY**. No GO:

- Companion apply / restart (live Jetson, systemd, GStreamer) — Issue #28
- ARM / DISARM / LAND / SET_MODE / live FC write / auto-landing — Issue #29
- Secrets / deploy to devices / flight commands

Merge autonomy still on for independently VERIFIED safe draft PRs. Hard safety stops stay draft until Roy.

---

## Audit snapshot — 2026-09-25 (ArduPlane land command)

**Master tip before this draft:** `1.02.320` at `498c356`.

Voice and console "land" for fixed-wing no longer sends ArduPlane custom mode 14. That number is AVOID_ADSB. Land sends `MAV_CMD_DO_LAND_START` only after a fresh mission read shows a DO_LAND_START item. No marker, an unreadable mission, or a copter sends nothing and says why in Hebrew. Voice mode changes use a per-vehicle allowlist. AVOID_ADSB, INITIALISING, and numeric mode strings are not sent. AUTOLAND, QLAND, and LOITER_ALT_QLAND use the same DO_LAND_START path, not SET_MODE. ARM / DISARM stay blocked. Heartbeat vehicle state ignores GCS and companion heartbeats.

This does not connect a live vehicle and does not add ARM, DISARM, or Companion apply / restart.

SIM badge, simulator preset, sim tagging, mode-change confirmation, and extra voice phrases stay for later PRs.

### Next pick

Do not start Companion apply/restart or a live-vehicle connect. Those stay Human Gates.

---

## Audit snapshot — 2026-09-12 (honest Companion vision / landing status)

**Master tip before this draft:** `1.02.291` after #111.  
**This draft:** Observe-only Companion camera + runway status. `APP_VERSION` **1.02.292**. Display only. No live camera required for tests.

### Landed

- Experiment #1 checklist is on master: PIC hand-fly, observe-only, success = runway detect on final.
- Annotated vision cellular-only honesty is on master (#111).
- E3372 `modem_absent` honesty is on master (#110). Dual-link radio + cellular remain MAVLink.

### This draft

Live companion 2.3.1 had no vision/landing routes, so readiness stayed unknown. Repo agent 2.3.3 keeps the 2.3.1 UART fan-out and reports explicit `camera_ok: false` / `runway_detector: false` / optical-nav `position: null` (absent). Landing path 404 stays not_implemented. Lock omitted stays unknown. Never invent detect, lock, or WGS84.

### Next pick

Do not start #28 / #29. King may upload the 2.3.3 agent after VERIFY. Prefer another display-only honesty or in-app development step — not flight commands.

### Ranked GAPS

1. **Honest Companion vision / landing status** — this draft.
2. **Companion apply/restart** — Human Gate #28. No GO.
3. **Live vehicle + auto landing** — Human Gate #29. No GO.

### Explicitly not next

Do not spend cycles on AH polish, Pulse chrome, another runway polish pass, inventing a Companion token, Jetson apply/restart, flight commands, C10.7b voice/STT, or C10.4c-b Jetson deploy-wire move.

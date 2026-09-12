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

Do not start #28 / #29. King may upload the 2.3.2 agent after VERIFY. Prefer another display-only honesty or in-app development step — not flight commands.

### Ranked GAPS

1. **Honest Companion vision / landing status** — this draft.
2. **Companion apply/restart** — Human Gate #28. No GO.
3. **Live vehicle + auto landing** — Human Gate #29. No GO.

### Explicitly not next

Do not spend cycles on AH polish, Pulse chrome, another runway polish pass, inventing a Companion token, Jetson apply/restart, flight commands, C10.7b voice/STT, or C10.4c-b Jetson deploy-wire move.

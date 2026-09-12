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

## Audit snapshot — 2026-09-12 (P2 runway lock status to GCS)

**Master tip before this draft:** `1.02.288` after #107.  
**This draft:** Honest observe-only runway lock chips. `APP_VERSION` **1.02.289**. Display only.

### Landed

- Experiment #1 checklist is on master: PIC hand-fly, observe-only, success = runway detect on final.
- Honest camera/vision probe and PLND profile are on master. Lock was a later-stage stub.

### This draft

`runway_lock` shows `not` / `detecting` / `locked` from an explicit Companion/vision lock field, or `unknown` when no lock signal exists. Detect + confidence never invents locked. `requiredForExperiment1` stays false. Mission detect glance stays detect-only; an adjacent lock glance never copies detect. `/api/vision/landing-readiness` adds `runwayLock: { state, source }`.

### Next pick

Do not start #28 / #29. Prefer another display-only honesty or in-app development step — not flight commands.

### Ranked GAPS

1. **Honest runway lock status to GCS** — this draft.
2. **Companion apply/restart** — Human Gate #28. No GO.
3. **Live vehicle + auto landing** — Human Gate #29. No GO.

### Explicitly not next

Do not spend cycles on AH polish, Pulse chrome, another runway polish pass, inventing a Companion token, Jetson apply/restart, flight commands, C10.7b voice/STT, or C10.4c-b Jetson deploy-wire move.

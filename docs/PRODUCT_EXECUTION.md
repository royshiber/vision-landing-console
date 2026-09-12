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

## Audit snapshot — 2026-09-12 (Vision Landing Readiness)

**Master tip before this draft:** `1.02.280` @ `52cc425` (PR #98 — Jetson E3372 host pack).  
**This draft:** Vision Landing Readiness checklist. `APP_VERSION` **1.02.281**. Stay draft until VERIFY. Display only.

### Landed

- Mission glance **מוכנות**, Status **סטטוס מחשבים**, and diagnostics now share one honest Vision Landing checklist: Jetson reachability, FC heartbeat, camera/vision pipeline, PLND / vision-nav profile, cellular annotated video, recording, flight-command gate.
- Camera / heartbeat / video never invent an OK. `modem_absent` is missing video. No manual-record API → not-recording. ARM / LAND / auto-land stay Human Gate #29 and are not enabled.
- Companion BOTH gate unchanged. No Companion-real widening. No live vehicle.

### This draft

Operator question: אפשר להתחיל ניסוי נחיתה ויזואלית? Hebrew chips on / warn / off. Each row has a one-line מה חסר. Experiment stays not-ready while flight commands are gated.

### Next pick

Do not start #28 / #29. Highest remaining GAP after this surface is still live-vehicle / auto-land (gated) or Companion apply/restart (gated). Prefer another display-only honesty or in-app development step — not flight commands.

### Ranked GAPS

1. **Vision Landing Readiness** — this draft.
2. **Companion apply/restart** — Human Gate #28. No GO.
3. **Live vehicle + auto landing** — Human Gate #29. No GO.

### Explicitly not next

Do not spend cycles on AH polish, Pulse chrome, inventing a Companion token, Jetson apply/restart, or flight-command send.

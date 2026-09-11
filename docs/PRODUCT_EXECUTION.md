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

## Audit snapshot — 2026-09-10 (F4 Ask → Capability Brief)

**Master tip before this draft:** `1.02.268` @ `2cffa19` (PR #88 — F2 Capability Runway).  
**This draft:** F4 Ask → Capability Brief. `APP_VERSION` **1.02.269**. Stay draft until VERIFY.  
**Tip after merge 269:** master carried F1 + F2 + F4. **F3 / Concept B** is this draft: Develop chat + live preview.

### Landed

- **F1 Capability Intake Studio** — master `1.02.267` via PR #87 `3897a70`. Now hidden under Concept B; composer remnants stay for Ask handoff.
- **Develop Concept B** — this draft `1.02.274`. Locked split: live map preview left, Hebrew chat right. MCQ rows plus free text. After VERIFY, install payload is visible and the install is allowed without another in-UI ask. Local progress only. No live Jetson/FC apply. Parameters hook after land.
- **F2 Capability Runway** — master `1.02.268` via PR #88 `2cffa19`. IDEA → RUNNING → VERIFY → PR → DONE from real task fields only.
- C10.6 Mission flight-safe Assist stays: no `CREATE_DEVELOPMENT_TASK` on Mission; DEVELOPMENT / coding-agent start refused in spoken Hebrew.
- AIRVIX Ask naming only. Jetson / מחשב משימה. No מסייע. No מלווה. No AH polish / «הגדל את האופק».

### This draft (F4)

Ask on non-Mission surfaces drafts a Capability Brief (מה / למה / מודולים / FEATURE default) with **פתח בפיתוח** / **שמור טיוטה** / **התחל סוכן**. Handoff fills the F1 composer and switches to Develop. Save and start reuse `CREATE_DEVELOPMENT_TASK` and the existing agent stack. Mission still refuses.

### Next pick

**F3** after this draft merges as 269. Do not start #28 / #29. Do not polish AH. Do not invent GPS or a Companion token.

### Ranked GAPS

1. **F4 Ask → Capability Brief** — this draft. Version **1.02.269**.
2. **F3** — next after merge 269.
3. **Companion apply/restart** — Human Gate #28. No GO.
4. **Live vehicle + auto landing** — Human Gate #29. No GO.

### Explicitly not next

Do not spend cycles on AH polish, Pulse chrome, another runway polish pass, inventing a Companion token, Jetson apply/restart, flight commands, C10.7b voice/STT, or C10.4c-b Jetson deploy-wire move.

# RAG and knowledge sources — trust tiers

This document extends [ADVISOR_SAFETY.md](./ADVISOR_SAFETY.md) for **retrieval-augmented** advisor answers (local `/docs`, future ArduPlane corpus, logs, and LLM priors). It does not replace the server trust boundary: **all `param_change` writes still pass** `validateOptions` / `validateSingleForApply` in [lib/advisor-actions.mjs](../lib/advisor-actions.mjs).

Version: 1.0 · 2026-04-25

---

## 1. Mapping to the risk register

| Tier (below) | Primary risks mitigated |
|--------------|-------------------------|
| A — Internal approved docs | R4 (injection via crafted docs is still possible but lower; treat as org policy, not user paste), R16 (writes still gated) |
| B — External corpus (e.g. ArduPlane wiki/code RAG) | R1, R2, R4, R10, R16 |
| C — Pilot notes / log excerpts | R4, R16 |
| D — LLM training / general knowledge | R1, R2, R16 |

**R16 (LLM as attack vector):** No matter what the model or RAG returns, **only** parameters in the server allowlists with values inside server safe ranges can be applied. RAG may **explain** or **cite**; it must not introduce new writable params.

**R1 / R2:** Retrieval may mention any parameter name; the server rejects proposals outside the allowlist or safe numeric range.

**R4:** Any block that is not explicitly “trusted internal policy” must be framed as **untrusted** in the system prompt (user question, logs, STATUSTEXT, Tier B/C excerpts). The model must not follow instructions embedded there.

---

## 2. Trust tiers (knowledge)

| Tier | Examples | Allowed in prompt | Allowed to drive `param_change` |
|------|-----------|-------------------|----------------------------------|
| **A** | Files under `docs/` after review (ADVISOR_SAFETY, JETSON_AGENT, etc.) | Yes; cite file path | Only if param appears in allowlist and value passes range checks |
| **B** | ArduPlane / ArduPilot upstream docs or code indexed locally | Yes; tag as external; include version metadata when available | **No** direct write from “discovered” params — explanation + link only; writes still Tier A allowlist |
| **C** | [lib/retrieval.mjs](../lib/retrieval.mjs) — flight notes, log excerpts | Yes; **UNTRUSTED** | Same as A for writes (allowlist only) |
| **D** | Model prior / general ArduPilot knowledge | Yes; limited | Never as sole justification for a write |

---

## 3. Tier A — approving a new internal doc

1. Author or update Markdown under `docs/`.
2. Review for operational accuracy (pilot + maintainer sign-off for flight-critical prose).
3. Merge only after updating [ADVISOR_SAFETY.md](./ADVISOR_SAFETY.md) if the doc introduces new **behaviour** of the advisor or new **action kinds** / allowlist entries.
4. RAG indexing reads from disk at runtime; no separate “publish” step for `/docs` in v1.

---

## 4. Tier B — ArduPlane (or full upstream) index (future)

When indexing external trees:

- Store **metadata** per chunk: `source`, `path`, `license` (e.g. GPL for ArduPilot), `ardu_version` or commit SHA, `vehicle` (e.g. plane).
- **Do not** widen the advisor allowlist automatically from RAG hits.
- Prefer **short excerpts + link** to official docs for parameters not on the allowlist.

---

## 5. Implementation reference (code)

| Piece | Role |
|-------|------|
| [lib/docs-retrieval.mjs](../lib/docs-retrieval.mjs) | Token overlap over `/docs` `*.md` chunks (Tier A) |
| [lib/retrieval.mjs](../lib/retrieval.mjs) | Notes/logs (Tier C) |
| [lib/gemini-advisor.mjs](../lib/gemini-advisor.mjs) | Injects retrieval blocks into the system instruction |
| [lib/param-schema.mjs](../lib/param-schema.mjs) | `FC_ADVISOR_WRITE_BOUNDS` — canonical numeric bounds for advisor FC writes |
| [lib/advisor-actions.mjs](../lib/advisor-actions.mjs) | Allowlist + validation (trust boundary) |

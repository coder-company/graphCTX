# graphCTX — M1 Plan ("Memory core")

> **Status: PLAN ONLY.** No M1 code is written yet. M0 (thesis spike) is complete
> and the gate is passed (push beats pull; live negative-control + A/B/C/N/S).
> This document is the contract for M1, derived from SPEC §27 (Phase M1) and the
> engines in SPEC §11–§12.

## Goal

Turn the M0 spike into a **trustworthy memory core**: real semantic retrieval,
an invalidation engine that keeps memory coherent, and a promotion engine with
**hard gates** (no weighted scoring) so only earned facts cross scope boundaries.

**SPEC M1 exit gate:** *workspace-promotion precision ≥ 90%.*

---

## Scope (what M1 adds)

### 1. Vectors — `retrieve/vectors.ts` (sqlite-vec)
- Add the `sqlite-vec` extension; create `fact_vectors USING vec0(fact_id, embedding FLOAT[1536])` (SPEC §400-402).
- Embedding cache keyed by fact content hash; index kept warm in the MCP process.
- Hybrid retrieval: union of `vector(query, scope=session, k=20)`, `vector(query, scope=workspace, k=40)`, plus the existing BM25/FTS path; merge + rerank (SPEC §624-625).
- Local-first: embeddings via a local model or configured provider; **no network on the hot path** (cache lookups only); graceful fallback to BM25 if vectors unavailable.
- **Exit check:** hybrid retrieval recall ≥ BM25-only on the M0 fixtures; vector path adds zero hot-path network calls; p95 hook latency stays < 150ms.

### 2. Invalidation engine — `invalidate/{invalidator,relation}.ts`
- `processIncomingFact(newFact)`: retrieve potential conflicts (same subject/predicate, overlapping scope/branch), classify each relation, then act (SPEC §11).
- `relation.ts` **deterministic-first** classifier: `same` / `refines` / `invalidates` / `conflicts` / `coexists` / `unrelated`; git-proof rules (file deleted → invalidates; branch-disjoint → coexists; repo-vs-user → coexists w/ OVERRIDES edge).
- LLM fallback (`llm_invalidation_agent`): structured output **with cited evidence IDs**, **may not** invalidate from world knowledge — enforced by prompt + post-check that cited evidence exists.
- Edges: `SUPERSEDES`, `INVALIDATES`, `CONFLICTS_WITH`, `OVERRIDES`; `markDisputed` for true conflicts.
- **Exit check:** on a labeled conflict set, deterministic rules cover the obvious cases; LLM fallback never invalidates without existing cited evidence (post-check test); superseded facts stop being injected.

### 3. Promotion engine — `promote/{gates,probation}.ts` (HARD GATES)
- `sessionToWorkspace` and `workspaceToUser` exactly as SPEC §12 — **hard boolean gates, no weighted scoring** (D6).
- Reject secrets/credentials and `task_state`; reject bad lifecycle (`disputed`/`expired`/`rejected`); hold facts with unresolved conflicts as `candidate`.
- Promote only on: user-explicit repo-scope, high-trust + deterministic repo evidence, verified procedures (≥ `min_procedure_successes`), or repeated failures/constraints across sessions.
- `probation.ts`: candidates require clean lifecycle + no unresolved conflict + (perishable) verification before becoming `active`. Sweeps run in the MCP worker and on `SessionEnd`.
- **Exit check (THE M1 GATE): workspace-promotion precision ≥ 90%** on a labeled promotion set — i.e. ≥ 90% of auto-promoted workspace facts are genuinely repo-true and scope-correct, with zero secret/task_state leakage.

### 4. Full commit anchoring — extend `git/anchors.ts`
- Populate `valid_from_commit` / `introduced_by_commit` on every promoted fact; ancestry-filter candidates to HEAD before injection (extend M0's anchoring beyond deterministic facts).
- Branch awareness for the `coexists`/branch-disjoint invalidation rules.
- **Exit check:** a fact introduced on a feature branch is not injected on an unrelated branch; a fact whose introducing commit is not an ancestor of HEAD is filtered out.

### 5. `why` / provenance surface
- `why(fact_id)` returns the evidence chain: source events, asserting actor, raw quote, git anchor, promotion decision + gate that fired, and any edges.
- **Exit check:** every active fact resolves a complete provenance chain; promotion decisions are auditable (which gate, what evidence).

### 6. Security — `security/` (trust + secrets, full)
- Trust tiers fully enforced through promotion (low-trust repo prose framed as claim, I2; can never auto-promote to user scope).
- Secret/entropy scan on **every extracted fact and every capsule pre-send** (I3); matches → `sensitivity=secret`, excluded from promotion + injection.
- **Exit check:** seeded secrets are never promoted and never appear in a capsule (extends the M0 secrets tests to the promotion path).

---

## Out of scope for M1 (deferred)
- LLM fact extraction / procedure mining (M3) — M1 keeps deterministic extraction as the trusted base; the LLM is used only as the invalidation *fallback*.
- Full injection loop: centroid-drift relevance gate, channel ladder, `PreToolUse` micro-injection, full budgeter (M2).
- Multi-client adapters, proxy, MCP notifications, telemetry-driven scoring (M4).
- Any cloud/sync tier — M1 stays strictly local-first.

---

## Build order (dependency-respecting)
1. `retrieve/vectors.ts` + hybrid rerank (extends existing retriever; no behavior change to push).
2. `invalidate/relation.ts` (deterministic) → `invalidate/invalidator.ts` → wire into fact insert path.
3. `promote/gates.ts` (pure functions, heavily unit-tested) → `promote/probation.ts` → MCP-worker + `SessionEnd` sweeps.
4. Extend `git/anchors.ts` to full commit anchoring + branch filtering; wire into retrieval candidate filter.
5. `why` provenance reader.
6. Full `security/` enforcement across the promotion path.

## Test / eval plan (gate evidence)
- **Promotion precision harness** (new eval suite): labeled fact set → run gates → measure precision/recall of workspace promotions; **must report ≥ 90% precision** to pass the M1 gate.
- **Invalidation suite:** labeled conflict pairs; assert deterministic coverage + LLM cited-evidence post-check + that superseded facts stop being injected.
- **Anchoring suite:** branch-disjoint and non-ancestor facts are filtered.
- **Security regression:** secrets never promote/inject (extends M0 `secrets.test.ts`).
- **Invariants preserved:** all M0 invariants I1–I9 must still hold; vitest + tsc + biome stay green; hook p95 < 150ms.

## Invariants touched in M1
- **I2** (trust framing), **I3** (secret scrubbing), **I4** (synchronous staleness verify) — all strengthened through the promotion + invalidation paths.
- **I5** (commit-valid grounding) — fully realized via complete anchoring.
- **I7** (provenance) — surfaced via `why`.
- **I9** (never break the agent) — every new path wrapped; failures degrade to no-memory, never a thrown hook.

> **Reminder:** do not start M1 until this plan is approved. Build it in order,
> then pass the **≥ 90% workspace-promotion precision** gate before earning M2.

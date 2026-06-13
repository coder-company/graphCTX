# Notes — extracted ideas from `memory_startup_architecture.ipynb`

> A reference Neo4j-backed memory architecture for a general "AI that improves over
> time." It's a *different product* from graphCTX (user-assistant memory, pull-centric,
> wall-clock, Neo4j-heavy) — but it independently validates our temporal-fact pattern
> and contains a few ideas worth stealing. This note records what we take, what we
> reject, and where each idea lands in our roadmap.

| | |
|---|---|
| Source | `memory_startup_architecture.ipynb` (untracked, repo root) |
| Verdict | Same DNA, different shape. Steal selectively. |

---

## 1. What it is (one paragraph)

A memory layer with the loop **capture → consolidate → recall → invalidate**, backed by
Neo4j (graph) + a vector index. Core pieces: profile summary, atomic temporal facts
(`subject/predicate/object`, `valid_at`/`invalid_at`, `SUPERSEDED_BY`), open loops,
style fingerprint, ambient recall (pre-generation packet), deep recall (`search_memory`
tool), a background consolidation job, and an episode store ("keeps receipts").

---

## 2. Confirms what we already do (validation, not new work)

- **Temporal facts + invalidation, never overwrite.** Set `invalid_at` + reason, link
  `SUPERSEDED_BY`, keep the source trail. → our `t_expired`/`invalidated_by` + I5 (append-only).
- **Small fact layer, big episode layer.** "Fact layer stays small; episode layer keeps
  receipts." → our conservative promotion + append-only episode log.
- **Hybrid recall** (semantic + keyword + one-hop graph + rerank). → our multi-signal retrieval.
- **Consolidation discipline** ("store only explicit, durable, useful; prefer small facts;
  invalidate only on clear contradiction"). → our promotion hard gates.

These reassure us the architecture is sound. No action needed.

---

## 3. What we STEAL (ranked)

### S1 — "Open loops" as a first-class fact kind ⭐ (highest value)
Unresolved threads that should *resurface later* (`kind='open_loop'`, invalidated when
resolved). For a coding agent this maps perfectly to: a half-finished task, a pending
TODO, a still-failing test, a deferred refactor, "we agreed to come back to X."

- **Why it's great for us:** it's exactly the missing piece of compaction recovery. After
  `PostCompact` the agent should be re-handed its *open loops*, not just static repo facts.
  This is the difference between "remembers the repo" and "remembers what it was doing."
- **Where it lands:**
  - Add `open_loop` to `FactKind` (currently we have `task_state`/`failure`; `open_loop`
    is the *durable, resurfacing* cousin — task_state is ephemeral, open_loop persists
    until explicitly resolved).
  - Retrieval: always include active open loops in the **PostCompact** and **SessionStart**
    capsules (a dedicated capsule section: "Open loops / unfinished work").
  - Lifecycle: an open loop is invalidated when a later event resolves it (links
    `SUPERSEDED_BY` the resolving fact/outcome) — fits our invalidation engine (M1).
- **Effort:** small. One enum value, one capsule section, one retrieval query, one
  resolution rule. **Do this in M1.**

### S2 — Style fingerprint as a compact, separate signal
"Lightweight interaction tendencies" stored separately from hard facts. We already have
a user graph (static/dynamic); a *style fingerprint* is a distilled, always-injected
sliver of it (e.g. "concise answers; runs tests before done; prefers functional TS").

- **Where it lands:** a single compact `style` fact (or a derived field) that's cheap to
  always include in SessionStart. Maps to our `preference` kind + user_static scope.
- **Effort:** small. **M1/M2** (it's just a curated subset of user facts + a capsule line).

### S3 — Explicit consolidation prompt as our LLM-extraction baseline
Its `CONSOLIDATION_INSTRUCTIONS` is a clean, conservative extraction prompt: return
`profile_summary_update`, `style_fingerprint_update`, `new_facts`, `invalidations`;
"prefer small facts," "invalidate only on clear contradiction," "consent for sensitive."

- **Where it lands:** seed `extract/llm/prompts/fact_extract.v1.md` and the invalidation
  agent prompt from this. It already encodes our discipline. **M3** (LLM extraction).

### S4 — One-hop entity expansion in retrieval
`(fact)-[:ABOUT]->(Entity)<-[:ABOUT]-(neighbor fact)` — pull neighbors that share an
entity. Cheap graph reasoning without full traversal.

- **Where it lands:** our entity-overlap signal already approximates this; when we add
  the entities table + edges in M1, add a one-hop expansion query to the retriever.
  **M1/M2**, optional — only if measured to improve injection (per D5: don't add graph
  unless it helps).

### S5 — `confidence` + recency in the rerank
It reranks by relevance × confidence × recency × task-fit. We have confidence on facts;
make sure the budgeter/ranker actually uses confidence + recency (not just similarity).
- **Where it lands:** retrieve/rank.ts weighting. **M2.**

---

## 4. What we REJECT (and why)

| Their choice | Our choice | Why |
|---|---|---|
| **Neo4j server required** | Local SQLite (FTS5 + sqlite-vec) | D3/D4: zero-friction local-first; no heavy dependency |
| **Wall-clock `valid_at`/`invalid_at`** | Commit-anchored validity | Branch/revert truth — wall-clock is wrong for code |
| **Pull-centric** (`search_memory` tool is the real-time channel; "ambient recall" loaded once) | Deterministic lifecycle **push** (hooks) | Our entire thesis: pull is a compliance problem |
| **General user/assistant memory** (Profile, preferences, style of a person) | Coding-workspace memory (repo facts, procedures, generated-code boundaries) | Different customer; we're dev tooling |
| **No trust model / no security** | Trust tiers + secret scan + prose-injection defense | Repos are adversarial; persistent injection is a real threat (I2/I3) |
| **No promotion tiers** | session→workspace→user hard gates | Conservative graduation under uncertainty is our discipline |

---

## 5. Net actions

| ID | Action | Milestone | Size |
|---|---|---|---|
| S1 | Add `open_loop` FactKind + "Open loops" capsule section (PostCompact + SessionStart) + resolution-invalidation | **M1** | S |
| S2 | Style fingerprint as a curated always-injected user_static sliver | M1/M2 | S |
| S3 | Seed LLM extraction + invalidation prompts from `CONSOLIDATION_INSTRUCTIONS` | M3 | S |
| S4 | One-hop entity expansion query in retriever (only if it measurably helps) | M1/M2 | S, optional |
| S5 | Ensure rank uses confidence + recency, not just similarity | M2 | S |

> Headline steal: **S1 (open loops)** — it's the piece that turns "remembers the repo"
> into "remembers what it was doing," and it's a near-free win for compaction recovery.
> Everything else either confirms our design or is a small refinement. The four axes
> where we diverge (push, commit-anchored, local SQLite, coding-specific + secure) are
> exactly our differentiation — the notebook reinforces that they're real choices.

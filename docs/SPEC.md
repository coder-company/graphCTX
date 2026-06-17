# graphCTX — Engineering Specification

> The complete, buildable blueprint. This document defines **exactly** what we build:
> every module, schema, interface, algorithm, file, and contract. If the PRD is *why*
> and the GAMEPLAN is *strategy*, this is *how* — precise enough to implement without
> further design decisions.

| | |
|---|---|
| **Status** | v1.0 — implementation-ready |
| **Last updated** | 2026-06-13 |
| **Companion docs** | [PRD.md](PRD.md) · [GAMEPLAN.md](GAMEPLAN.md) |
| **Target** | Node ≥ 20 / Bun ≥ 1.3 · TypeScript 5.x · SQLite (better-sqlite3) |

---

## Table of contents

1. [System overview](#1-system-overview)
2. [Repository & module layout](#2-repository--module-layout)
3. [Runtime topology & processes](#3-runtime-topology--processes)
4. [Dependencies](#4-dependencies)
5. [Configuration](#5-configuration)
6. [Storage layer — SQLite schema](#6-storage-layer)
7. [Core domain types](#7-core-domain-types)
8. [Git layer](#8-git-layer)
9. [Capture layer (episodes)](#9-capture-layer)
10. [Extraction layer](#10-extraction-layer)
11. [Invalidation engine](#11-invalidation-engine)
12. [Promotion engine](#12-promotion-engine)
13. [Retrieval engine](#13-retrieval-engine)
14. [Conflict & precedence resolver](#14-conflict--precedence-resolver)
15. [Injection planner (the core)](#15-injection-planner)
16. [Capsule renderer](#16-capsule-renderer)
17. [Adapter layer & channel ladder](#17-adapter-layer)
18. [MCP server](#18-mcp-server)
19. [CLI](#19-cli)
20. [Security module](#20-security-module)
21. [Telemetry & metrics](#21-telemetry--metrics)
22. [Evaluation harness](#22-evaluation-harness)
23. [Error handling & logging](#23-error-handling--logging)
24. [Performance budgets](#24-performance-budgets)
25. [Testing strategy](#25-testing-strategy)
26. [Build & distribution](#26-build--distribution)
27. [Implementation order (build sequence)](#27-implementation-order)
28. [Definition of done](#28-definition-of-done)

---

## 1. System overview

graphCTX is a **local daemon + CLI + MCP server + client adapters** that:
1. **Captures** agent activity (prompts, tool calls, file changes, git state) into an append-only episode log.
2. **Extracts** facts (deterministically first, LLM second) and stores them in a commit-anchored temporal SQLite store across three scopes (session / workspace / user).
3. **Promotes** facts conservatively between scopes via hard gates.
4. **Pushes** the right context into the agent at deterministic lifecycle moments via a capability-detected channel ladder.

**Design invariants (never violate):**
- **I1** — No fact is `active` on creation; default is `candidate`.
- **I2** — Repo *prose* is `trust_tier: low`; never auto-promoted, never executable.
- **I3** — Secrets/credentials are never promoted and never injected.
- **I4** — Perishable (procedural) facts are verified synchronously before injection.
- **I5** — Writes to durable scopes are append-only; truth is never mutated in place (only metadata + lifecycle transitions).
- **I6** — Injection respects token budgets; selection optimizes utility/token, not volume.
- **I7** — Every injected card carries provenance (`[mem:id]`).
- **I8** — MCP tool surface ≤ 8 tools.

---

## 2. Repository & module layout

```
graphCTX/
├── docs/                       PRD.md · GAMEPLAN.md · SPEC.md
├── src/
│   ├── cli.ts                  CLI entrypoint (bin: graphctx)
│   ├── index.ts                public programmatic API
│   ├── config/
│   │   ├── config.ts           load/merge/validate config
│   │   ├── defaults.ts         default config values
│   │   └── schema.ts           zod schema for config
│   ├── core/
│   │   ├── types.ts            domain types (Fact, Entity, Edge, …)
│   │   ├── ids.ts              UUID/ULID helpers
│   │   ├── errors.ts           typed error hierarchy
│   │   └── clock.ts            time + ISO-8601 helpers (injectable for tests)
│   ├── store/
│   │   ├── db.ts               connection factory (WAL, pragmas)
│   │   ├── migrations/         numbered .sql migrations
│   │   ├── migrate.ts          migration runner
│   │   ├── facts.repo.ts       Fact CRUD + queries
│   │   ├── entities.repo.ts    Entity CRUD
│   │   ├── edges.repo.ts       Edge CRUD
│   │   ├── episodes.repo.ts    Episode append/read
│   │   ├── procedures.repo.ts  Procedure CRUD
│   │   ├── injections.repo.ts  Injection-event logging
│   │   └── vectors.ts          sqlite-vec wrapper + embedding cache
│   ├── git/
│   │   ├── git.ts              simple-git wrapper
│   │   ├── dag.ts              ancestry/reachability, merge-base
│   │   └── anchors.ts          commit-validity logic + path/patch fingerprints
│   ├── capture/
│   │   ├── episode-log.ts      append-only JSONL + DB mirror
│   │   └── normalizers.ts      shape raw client events → Episode
│   ├── extract/
│   │   ├── deterministic/
│   │   │   ├── package-scripts.ts
│   │   │   ├── editorconfig.ts
│   │   │   ├── lockfile.ts        (package manager detection)
│   │   │   ├── ci.ts             (.github/workflows, etc.)
│   │   │   ├── generated-markers.ts
│   │   │   └── agent-files.ts    (AGENTS.md/CLAUDE.md/README → LOW trust)
│   │   ├── llm/
│   │   │   ├── fact-extractor.ts
│   │   │   ├── procedure-miner.ts
│   │   │   └── prompts/          versioned prompt templates
│   │   └── pipeline.ts          orchestrates sync + async extraction
│   ├── invalidate/
│   │   ├── invalidator.ts       relation classify + expire/supersede
│   │   ├── relation.ts          deterministic relation checks
│   │   └── staleness.ts         synchronous perishable-fact verification
│   ├── promote/
│   │   ├── gates.ts             hard-gate rules (session→ws, ws→user)
│   │   ├── promoter.ts          candidate → active transitions
│   │   └── probation.ts         probation/disputed handling
│   ├── retrieve/
│   │   ├── retriever.ts         multi-signal retrieval + scope composition
│   │   ├── signals.ts          semantic + BM25 + entity scorers
│   │   └── rank.ts             fusion + diversity
│   ├── resolve/
│   │   ├── precedence.ts        precedence ordering
│   │   └── conflicts.ts         conflict detection/resolution
│   ├── inject/
│   │   ├── planner.ts           trigger → plan → budget → capsule
│   │   ├── gate.ts              relevance gate (drift/entity/event-class)
│   │   ├── ledger.ts            per-session anti-repetition ledger
│   │   └── budget.ts            token budgeting + selection
│   ├── render/
│   │   ├── capsule.ts           capsule assembly
│   │   ├── cards.ts             per-fact card renderers
│   │   └── tokens.ts            token estimation
│   ├── adapters/
│   │   ├── adapter.ts           Adapter interface + capability detection
│   │   ├── claude-code/
│   │   │   ├── install.ts       writes hook config
│   │   │   ├── hooks.ts         hook event handlers
│   │   │   └── templates/       hook scripts + AGENTS.md capsule
│   │   ├── cursor/              (M4)
│   │   ├── opencode/            (M4)
│   │   └── proxy/               (M4 — Tier 4 fallback)
│   ├── mcp/
│   │   ├── server.ts            MCP server bootstrap
│   │   └── tools/               one file per tool
│   ├── llm/
│   │   ├── provider.ts          provider-agnostic chat/embeddings interface
│   │   ├── openai.ts            adapters per provider
│   │   ├── anthropic.ts
│   │   └── local.ts             (ollama / openai-compatible)
│   ├── security/
│   │   ├── trust.ts             trust-tier assignment
│   │   ├── secrets.ts           secret/credential detection
│   │   └── sanitize.ts          prose-instruction neutralization
│   ├── telemetry/
│   │   ├── metrics.ts           metric counters/timers
│   │   └── outcomes.ts          injection outcome classification
│   └── eval/
│       ├── harness.ts           A/B/C/.../H arm runner
│       ├── suites/              repo-drift, branch-truth, compaction, …
│       └── report.ts            results aggregation
├── test/                       mirrors src/ (unit + integration)
├── fixtures/                   sample repos & transcripts for eval
├── package.json
├── tsconfig.json
├── biome.json                  lint/format
└── vitest.config.ts
```

---

## 3. Runtime topology & processes

graphCTX runs as **three cooperating roles** over a shared SQLite store:

```
┌────────────────────────────────────────────────────────────────┐
│ Client (Claude Code)                                             │
│   ├─ hook scripts ──► `graphctx hook <event>` (short-lived CLI)  │
│   └─ MCP client ────► graphctx MCP server (stdio, long-lived)    │
└───────────────┬──────────────────────────────┬─────────────────┘
                │ hook (push)                    │ MCP (pull + rider)
                ▼                                ▼
        ┌─────────────────────────────────────────────┐
        │ graphctx core (library)                       │
        │  capture · extract · retrieve · inject · …    │
        └───────────────────────┬─────────────────────┘
                                 ▼
                     SQLite (user.db, workspace.db)
                                 ▲
                                 │ async worker (in-proc queue)
                     LLM extraction / promotion sweeps
```

- **Hook invocations** are short-lived `graphctx hook <event>` processes. They must be **fast** (see §24) — they do retrieval + render only; heavy extraction is deferred.
- **MCP server** is a long-lived stdio process started by the client. Hosts the tools and an in-process async worker for LLM extraction + periodic promotion/staleness sweeps.
- **Concurrency:** SQLite WAL mode; writes serialized via a single writer connection per DB; readers use separate connections. Cross-process writes coordinated by SQLite locking + `base_graph_version` optimistic checks for durable facts.

---

## 4. Dependencies

**Runtime (minimal, audited):**
- `better-sqlite3` — synchronous SQLite (fast, simple).
- `sqlite-vec` — vector index extension.
- `simple-git` — git operations.
- `@modelcontextprotocol/sdk` — MCP server.
- `zod` — config + tool input validation.
- `commander` — CLI parsing.
- `gpt-tokenizer` (or `tiktoken`) — token estimation.
- `ulid` — sortable IDs.
- LLM SDKs loaded lazily per configured provider (`openai`, `@anthropic-ai/sdk`); local via OpenAI-compatible HTTP.

**Dev:** `typescript`, `vitest`, `@biomejs/biome`, `tsx`, `@types/node`.

**Principle:** keep the dependency tree small and boring. No heavyweight frameworks. No required external services.

---

## 5. Configuration

Resolution order (later overrides earlier): built-in defaults → `~/.config/graphctx/config.json` → `<workspace>/.graphctx/config.json` → env vars (`GRAPHCTX_*`) → CLI flags.

```json
{
  "storage": {
    "user_db": "~/.local/share/graphctx/user.db",
    "workspace_db": ".graphctx/workspace.db",
    "episodes": ".graphctx/episodes.jsonl"
  },
  "llm": {
    "provider": "anthropic",
    "chat_model": "claude-haiku-4-5",
    "embed_model": "text-embedding-3-small",
    "api_key_env": "ANTHROPIC_API_KEY",
    "base_url": ""
  },
  "inject": {
    "total_budget_tokens": 2500,
    "budget_fraction": 0.015,
    "max_cards": 15,
    "max_cards_pretool": 5,
    "gate_drift_threshold": 0.35,
    "enabled_events": [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostCompact"
    ]
  },
  "promote": {
    "session_to_workspace": true,
    "workspace_to_user": "explicit_only",
    "min_procedure_successes": 2,
    "min_failure_repeats": 2
  },
  "security": {
    "secret_scan": true,
    "prose_trust": "low",
    "allow_executable_procedures": false
  },
  "telemetry": {
    "enabled": true,
    "local_only": true
  }
}
```

Config is validated by `config/schema.ts` (zod); invalid config fails fast with a clear error.

---

## 6. Storage layer

Two databases: `user.db` (user scope) and `workspace.db` (session + workspace scopes for one repo). Same schema; scope columns disambiguate. WAL mode, `foreign_keys=ON`, `busy_timeout=5000`.

### 6.1 Migrations (numbered, forward-only)

`migrations/0001_init.sql`:

```sql
CREATE TABLE facts (
  fact_id            TEXT PRIMARY KEY,
  subject_id         TEXT NOT NULL,
  predicate          TEXT NOT NULL,
  object_json        TEXT NOT NULL,
  fact_kind          TEXT NOT NULL,   -- semantic|episodic|procedural|preference|decision|constraint|failure|task_state
  temporal_kind      TEXT NOT NULL,   -- atemporal|static|dynamic
  scope_user_id      TEXT NOT NULL,
  scope_workspace_id TEXT,
  scope_session_id   TEXT,
  status             TEXT NOT NULL,   -- candidate|active|expired|superseded|disputed|rejected
  promotion_state    TEXT NOT NULL,
  trust_tier         TEXT NOT NULL,   -- high|low
  sensitivity        TEXT NOT NULL,   -- public|private|secret|credential|unknown
  confidence         REAL NOT NULL DEFAULT 0.5,
  evidence_count     INTEGER NOT NULL DEFAULT 1,
  contradiction_count INTEGER NOT NULL DEFAULT 0,
  injection_count    INTEGER NOT NULL DEFAULT 0,
  last_verified_at   TEXT,
  last_injected_at   TEXT,
  t_created          TEXT NOT NULL,
  t_recorded         TEXT NOT NULL,
  t_expired          TEXT,
  invalidated_by     TEXT REFERENCES facts(fact_id),
  tags_json          TEXT NOT NULL DEFAULT '[]',
  raw_quote          TEXT,
  graph_version      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE git_anchors (
  fact_id              TEXT PRIMARY KEY REFERENCES facts(fact_id) ON DELETE CASCADE,
  repo_id              TEXT,
  branch               TEXT,
  base_head            TEXT,
  introduced_by_commit TEXT,
  valid_from_commit    TEXT,
  valid_until_commit   TEXT,
  invalidated_by_commit TEXT,
  path_globs_json      TEXT,
  file_ids_json        TEXT,
  symbol_ids_json      TEXT,
  hunk_fingerprints_json TEXT,
  patch_id             TEXT
);

CREATE TABLE entities (
  entity_id          TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,
  canonical_name     TEXT NOT NULL,
  aliases_json       TEXT NOT NULL DEFAULT '[]',
  scope_user_id      TEXT NOT NULL,
  scope_workspace_id TEXT
);

CREATE TABLE edges (
  edge_id        TEXT PRIMARY KEY,
  from_id        TEXT NOT NULL,
  edge_kind      TEXT NOT NULL,
  to_id          TEXT NOT NULL,
  scope_json     TEXT,
  source_fact_id TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE episodes (
  event_id     TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  workspace_id TEXT,
  event_type   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  git_head     TEXT,
  git_branch   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE procedures (
  procedure_id   TEXT PRIMARY KEY,
  fact_id        TEXT NOT NULL REFERENCES facts(fact_id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  procedure_json TEXT NOT NULL,
  success_count  INTEGER NOT NULL DEFAULT 0,
  failure_count  INTEGER NOT NULL DEFAULT 0,
  last_success_commit TEXT,
  last_success_at TEXT
);

CREATE TABLE injections (
  injection_id      TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  selected_fact_ids_json TEXT NOT NULL,
  rejected_fact_ids_json TEXT,
  token_count       INTEGER NOT NULL,
  predicted_utility REAL,
  git_head          TEXT,
  outcome_json      TEXT,            -- filled in post-turn
  created_at        TEXT NOT NULL
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- schema_version, etc.

-- FTS5 for BM25 keyword retrieval
CREATE VIRTUAL TABLE facts_fts USING fts5(
  fact_id UNINDEXED, text, tags, content=''
);

-- Indexes
CREATE INDEX idx_facts_scope   ON facts(scope_user_id, scope_workspace_id, scope_session_id);
CREATE INDEX idx_facts_sp      ON facts(subject_id, predicate);
CREATE INDEX idx_facts_status  ON facts(status, promotion_state);
CREATE INDEX idx_facts_kind    ON facts(fact_kind);
CREATE INDEX idx_git_commit    ON git_anchors(repo_id, valid_from_commit, valid_until_commit);
CREATE INDEX idx_edges_from    ON edges(from_id, edge_kind);
CREATE INDEX idx_edges_to      ON edges(to_id, edge_kind);
CREATE INDEX idx_episodes_sess ON episodes(session_id, created_at);
```

Vector table (created via `sqlite-vec` in `vectors.ts`):
```sql
CREATE VIRTUAL TABLE fact_vectors USING vec0(fact_id TEXT, embedding FLOAT[1536]);
```

### 6.2 Repository contracts (representative)

```ts
// store/facts.repo.ts
interface FactsRepo {
  insert(fact: NewFact): Fact;                 // sets status='candidate' unless overridden
  get(id: string): Fact | null;
  update(id: string, patch: Partial<FactMeta>): void;   // meta/lifecycle only (I5)
  expire(id: string, by: string, atCommit?: string): void;
  bySubjectPredicate(s: string, p: string, scope: ScopeFilter): Fact[];
  activeAsOf(scope: ScopeFilter, commit: string | null): Fact[];
  candidates(scope: ScopeFilter): Fact[];
  search(opts: FtsQuery): ScoredFact[];        // FTS5/BM25
}
```

All repos are thin, synchronous (better-sqlite3), and transactional via a `tx(fn)` helper.

---

## 7. Core domain types

`core/types.ts` (authoritative TS definitions — mirror of §6 + the conceptual model from GAMEPLAN §9):

```ts
export type FactKind =
  | "semantic" | "episodic" | "procedural" | "preference"
  | "decision" | "constraint" | "failure" | "task_state";

export type TemporalKind = "atemporal" | "static" | "dynamic";
export type TrustTier = "high" | "low";
export type Sensitivity = "public" | "private" | "secret" | "credential" | "unknown";
export type FactStatus = "candidate" | "active" | "expired" | "superseded" | "disputed" | "rejected";
export type AssertedBy = "user" | "agent" | "tool" | "deterministic_parser" | "llm_extractor" | "git_watcher";

export interface Scope { user_id: string; workspace_id?: string; session_id?: string; }

export interface GitAnchor {
  repo_id?: string; branch?: string; base_head?: string;
  introduced_by_commit?: string; valid_from_commit?: string;
  valid_until_commit?: string; invalidated_by_commit?: string;
  path_globs?: string[]; file_ids?: string[]; symbol_ids?: string[];
  hunk_fingerprints?: string[]; patch_id?: string;
}

export interface Fact {
  fact_id: string;
  subject: string; predicate: string; object: unknown;
  fact_kind: FactKind; temporal_kind: TemporalKind;
  scope: Scope;
  status: FactStatus; promotion_state: PromotionState;
  trust_tier: TrustTier; sensitivity: Sensitivity;
  confidence: number; evidence_count: number; contradiction_count: number;
  injection_count: number; last_verified_at?: string; last_injected_at?: string;
  time: { t_created: string; t_recorded: string; t_expired?: string; invalidated_by?: string };
  git?: GitAnchor;
  source: { asserted_by: AssertedBy; event_ids: string[]; commit?: string; raw_quote?: string };
  tags: string[];
}

export type Event =
  | "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse"
  | "PreCompact" | "PostCompact" | "SessionEnd" | "FileChanged" | "BranchSwitch";

export interface InjectionContext {
  event: Event; scope: Scope;
  transcript_tail?: string; user_prompt?: string;
  current_files?: string[]; mentioned_symbols?: string[];
  planned_tool?: { name: string; args?: unknown };
  tool_result?: { success: boolean; stderr?: string; stdout_tail?: string };
  git: { repo_id: string; head: string; branch: string; dirty_files?: string[] };
  budget_tokens?: number;
}

export interface Capsule {
  markdown: string;
  cards: Array<{ fact_id: string; reason: string; tokens: number }>;
  omitted: Array<{ fact_id: string; reason: string }>;
  conflicts: Array<{ conflict_id: string; summary: string }>;
  token_count: number;
}
```

---

## 8. Git layer

`git/dag.ts` and `git/anchors.ts` implement commit-anchored validity (GAMEPLAN §6).

**Required operations:**
- `head(): SHA`, `branch(): string`, `dirtyFiles(): string[]`
- `isAncestor(a: SHA, b: SHA): boolean` — is `a` reachable from `b`
- `mergeBase(a, b): SHA`
- `detectEvent(prevHead, newHead): "fast-forward" | "merge" | "rebase" | "revert" | "switch"`
- `patchId(commit): string` — stable id across rebases (via `git patch-id`)
- `pathMatches(globs, file): boolean`

**Validity rule (`isValidAsOf`):** a fact is valid at `HEAD` iff
```
(valid_from_commit == null OR isAncestor(valid_from_commit, HEAD))
AND (valid_until_commit == null OR NOT isAncestor(valid_until_commit, HEAD))
AND (branch == null OR branch == currentBranch OR isAncestor(introduced_by_commit, HEAD))
```

**Event semantics:**
- **fast-forward/commit** → no change to existing facts unless extraction invalidates.
- **branch switch** → recompute `activeAsOf(newHead)`; branch-scoped facts filter out.
- **merge** → recompute against merge commit tree; surface conflicts if both sides assert contradictory facts.
- **revert** → re-validate facts whose `invalidated_by_commit` was the reverted commit (set `valid_until_commit=null`, status back to `active`).

---

## 9. Capture layer

`capture/episode-log.ts` — append-only. Every client event is normalized to an `Episode` and written to **both** `episodes.jsonl` (durable, greppable) and the `episodes` table (queryable). Writes are O(1) append; never blocks the hook path beyond a single synchronous insert.

`capture/normalizers.ts` maps each client's raw hook payload into the canonical `Episode` shape. One normalizer per adapter.

Captured event types: prompt submitted, tool call (name+args), tool result (success/stderr tail), file changed, compaction (pre/post), session start/end, branch switch, user correction (detected heuristically — user re-instructs after an agent action).

---

## 10. Extraction layer

Two-phase (GAMEPLAN §7, §2.4):

### 10.1 Deterministic (synchronous, runs in hook/MCP path, cheap)
Each extractor returns `NewFact[]` with `trust_tier` set:

| Extractor | Source | Produces | Trust |
|---|---|---|---|
| `package-scripts` | `package.json` scripts | test/build/dev/lint commands | **high** |
| `editorconfig` | `.editorconfig` | indentation/style constraints | **high** |
| `lockfile` | `*.lock` / `package-lock` | package manager | **high** |
| `ci` | `.github/workflows/*`, etc. | canonical CI commands | **high** |
| `generated-markers` | file headers / codegen config | "do not edit" boundaries | **high** |
| `agent-files` | `AGENTS.md`/`CLAUDE.md`/README | repo claims/instructions | **low** |

Deterministic facts may enter as `candidate` and are eligible for immediate promotion via gates (§12) if high-trust.

### 10.2 LLM (async, batched, in MCP worker)
- `fact-extractor.ts` — from session transcript batches: decisions, failed attempts, implied conventions, constraints, task state. Output is structured (JSON), validated by zod, each fact tagged `evidence:llm_extracted`, `trust_tier` derived from source.
- `procedure-miner.ts` — detects repeated multi-step workflows → `ProcedureMemory` (descriptive only; **no `safe_to_autorun`**).
- Prompts are **versioned files** under `prompts/` (e.g. `fact_extract.v1.md`) for auditability and A/B testing.
- Model: small/fast (Haiku-class) per config. Batched to amortize cost; never on the hot path.

---

## 11. Invalidation engine

`invalidate/invalidator.ts` (GAMEPLAN §6):

```
processIncomingFact(newFact):
  candidates = retrievePotentialConflicts(newFact)   # same subject/predicate, overlapping scope/branch
  for old in candidates:
    rel = classifyRelation(newFact, old)             # deterministic first, LLM fallback
    switch rel:
      same       -> mergeEvidence(old, newFact)
      refines    -> edge(newFact, SUPERSEDES, old); maybe expire old
      invalidates-> if allowed: expire(old, by=newFact, atCommit); edge(INVALIDATES)
      conflicts  -> markDisputed(newFact, old); edge(CONFLICTS_WITH)
      coexists   -> partitionByScopeOrBranch(newFact, old)
      unrelated  -> noop
  insertOrActivate(newFact)
```

`relation.ts` deterministic checks (run before any LLM):
- same subject+predicate+object → `same`
- git proves file deleted / script removed → `invalidates`
- branch-disjoint → `coexists`
- repo-scope vs user-scope → `coexists` with OVERRIDES edge

`llm_invalidation_agent` fallback returns one of `{same, refines, invalidates, conflicts, coexists, unrelated}` **with cited evidence IDs** and **may not** invalidate from world knowledge (hard rule, enforced by prompt + post-check that cited evidence exists).

`staleness.ts` — `verifyBeforeInject(fact): boolean` (I4): for procedural/perishable facts, synchronously check the referenced path/script/symbol still exists at HEAD. Fails → fact is excluded from this injection and flagged for re-verification. Cost target < 5ms.

---

## 12. Promotion engine

`promote/gates.ts` — **hard gates, no weighted scoring** (GAMEPLAN §7, D6).

```ts
function sessionToWorkspace(f: Fact, ctx): Decision {
  if (f.sensitivity === "secret" || f.sensitivity === "credential") return Reject("secret");
  if (f.fact_kind === "task_state") return Reject("session-local");
  if (["disputed","expired","rejected"].includes(f.status)) return Reject("bad lifecycle");
  if (hasUnresolvedConflict(f)) return Candidate("needs resolution");

  if (f.source.asserted_by === "user" && saysRepoScoped(f)) return Promote("user_explicit");
  if (f.trust_tier === "high" && hasDeterministicRepoEvidence(f)) return Promote("config_evidence");
  if (f.fact_kind === "procedural" && procSuccesses(f) >= cfg.min_procedure_successes) return Promote("verified_procedure");
  if (["failure","constraint"].includes(f.fact_kind) && repeatedAcrossSessions(f, cfg.min_failure_repeats)) return Promote("repeated");
  return Candidate("insufficient evidence");
}

function workspaceToUser(f: Fact, ctx): Decision {
  if (f.sensitivity === "secret" || f.sensitivity === "credential") return Reject("secret");
  if (!["preference","procedural","constraint"].includes(f.fact_kind)) return Reject("not profile material");
  if (f.source.asserted_by === "user" && saysGlobal(f))
    return Promote(f.temporal_kind === "static" ? "user_static" : "user_dynamic");
  if (isRepoConvention(f)) return Reject("repo convention != user preference");
  // v1: explicit_only — no inference
  return Candidate("explicit-only in v1");
}
```

`probation.ts` — candidates require: clean lifecycle, no unresolved conflict, and (for perishable) verification before becoming `active`. Promotion sweeps run periodically in the MCP worker and on `SessionEnd`.

---

## 13. Retrieval engine

`retrieve/retriever.ts` — multi-signal + scope composition (GAMEPLAN §2.4, §4).

```
retrieve(ctx: InjectionContext): ScoredFact[]:
  candidates = union(
    vector(ctx.query, scope=session,   k=20),
    vector(ctx.query, scope=workspace, k=40),
    bm25(ctx.query,   scope=workspace, k=40),
    entity(ctx.entities, scope=workspace, k=40),
    procedureSearch(ctx.planned_tool, ctx.files, k=20),
    userProfile(ctx.query, k=15),
    recentDynamicUser(k=10),
  )
  candidates = filter(candidates, isValidAsOf(HEAD))      # commit-anchored
  candidates = filter(candidates, status == active)
  return fuse(candidates)                                  # signals.ts + rank.ts
```

`signals.ts` produces three normalized scores (semantic cosine, BM25, entity-overlap). `rank.ts` fuses them (normalize → sum) and applies scope weights:

```
scopeWeight: session(self)=1.0, workspace=0.9, user_static=0.55, user_dynamic=0.40
```

Fusion is deterministic and simple in v1 (no learned weights — D6). Output is `ScoredFact[]` for the planner/budgeter.

---

## 14. Conflict & precedence resolver

`resolve/precedence.ts` precedence order (high→low) (GAMEPLAN §8.2, corrected):

```
0 safety / permissions
1 current-session explicit user instruction
2 repo STRUCTURED evidence at HEAD (config/lockfile/CI) — high trust only
3 workspace durable decision
4 user static profile
5 user dynamic profile
6 older session memory
7 agent inference
8 repo PROSE (AGENTS.md/README/comments) — low trust, below user profile
```

`resolve/conflicts.ts`:
- Group by `(subject, predicate)`; among active facts valid as-of HEAD, rank by precedence.
- Winner stays injectable; losers get `OVERRIDES` edges (scoped) or branch-partition or `disputed`.
- **Parallel-session writes** use optimistic concurrency: each durable write carries `base_graph_version` + `base_git_head`; on conflict → branch-disjoint=partition, deterministic-winner=invalidate, else=`disputed`. **Never silent last-writer-wins.** Injection surfaces a conflict note.

---

## 15. Injection planner

`inject/planner.ts` — the core orchestration (GAMEPLAN §5).

```
plan(ctx: InjectionContext): Capsule:
  if not gate.shouldFire(ctx): return EMPTY_CAPSULE
  budget = budget.resolve(ctx.event, ctx.budget_tokens)        # §5.5 caps
  scored = retriever.retrieve(ctx)
  resolved = conflicts.resolve(scored, ctx)                    # precedence + conflict notes
  verified = resolved.filter(f => !isPerishable(f) || staleness.verifyBeforeInject(f))  # I4
  deduped = ledger.removeRecentlyInjected(verified, ctx.scope.session_id)  # anti-repetition
  selected = budget.select(deduped, budget)                    # utility/token + diversity
  capsule = renderCapsule(selected, resolved.conflicts)
  ledger.record(ctx.scope.session_id, selected)
  injections.repo.log({ ...ctx, selected, capsule.token_count })
  return capsule
```

`inject/gate.ts` — `shouldFire(ctx)` (the invention, GAMEPLAN §5.2):
- `SessionStart`, `PostCompact` → **always** fire.
- `UserPromptSubmit` → fire if topic-centroid drift > `gate_drift_threshold` OR new entities present.
- `PreToolUse` → fire only if memory plausibly applies to the planned tool/args (e.g. Bash with a command we have facts about; Edit on a path with constraints).
- `PostToolUse` → fire only on failure with a known recovery.

`inject/ledger.ts` — per-session in-memory + DB-backed set of recently injected `fact_id`s with timestamps; suppresses re-injection across channels (cross-channel idempotency, I7-adjacent).

`inject/budget.ts` — greedy selection by `score / estimated_tokens` with a redundancy penalty and `must_include` bonuses (conflict notes, explicit user instructions). Hard cap on cards and tokens.

---

## 16. Capsule renderer

`render/capsule.ts` assembles the markdown capsule with fixed section order (GAMEPLAN §5.3):
`Task state · Repo constraints · Applicable procedure · User preferences · Conflict notes`.

`render/cards.ts` — per-kind card templates, each ≤ 250 tokens, each ending with a `[mem:<id>]` or `[proc:<id>]` provenance tag (I7). `render/tokens.ts` estimates tokens (gpt-tokenizer) for budgeting.

Output conforms to the `Capsule` type (§7). The same `Capsule` is delivered by **all** channels — rendering is channel-agnostic (the channel only changes the transport).

---

## 17. Adapter layer

`adapters/adapter.ts`:

```ts
interface Adapter {
  id: string;                                  // "claude-code" | ...
  detect(): Promise<Capability>;               // which push tiers available
  install(opts): Promise<void>;                // write hook/rules config
  uninstall(): Promise<void>;
  deliver(capsule: Capsule, ctx: InjectionContext, tier: ChannelTier): Promise<void>;
}
type ChannelTier = 0 | 1 | 2 | 3 | 4;          // GAMEPLAN §5.1 ladder
```

**Claude Code adapter (reference, M0):**
- `install.ts` writes hook entries (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionEnd`) that call `graphctx hook <event>` with the event payload on stdin.
- `hooks.ts` parses the payload → builds `InjectionContext` → calls `planner.plan()` → emits the capsule markdown on stdout (Tier 2 push). For `SessionStart` it also refreshes the `AGENTS.md` capsule (Tier 0).
- `templates/AGENTS.md.hbs` — boot capsule + a recall directive (Tier 0 floor).

**Capability detection** picks the highest available tier per client and routes `deliver()` accordingly. Cursor/OpenCode/proxy are M4.

---

## 18. MCP server

`mcp/server.ts` — stdio MCP server exposing **exactly 8 tools** (I8), one file each under `mcp/tools/`. Each tool validates input with zod and returns structured output.

| Tool | Purpose | Primary caller |
|---|---|---|
| `remember` | store a fact/event/procedure candidate | agent/user |
| `recall` | pull retrieval (fallback, **not** primary) | agent |
| `inject_context` | build+return capsule for an event | adapters/hooks |
| `checkpoint_session` | persist session state (pre-compact / end) | adapters |
| `promote` | manual/dry-run promotion | user |
| `forget` | expire/hard-delete | user |
| `why` | provenance/explanation | user/agent |
| `resolve_conflict` | resolve a disputed pair | user |

Every tool **response** may carry a parasitic rider (Tier 1) with a tiny fresh-context snippet, gated by the same ledger to avoid repetition. The MCP server also hosts the async extraction/promotion worker.

(Full I/O shapes per tool are defined in the GAMEPLAN §5 / PRD §10 and implemented as zod schemas in each tool file.)

---

## 19. CLI

`cli.ts` (commander). Commands map 1:1 to library functions; CLI is a thin shell.

```
graphctx init                          # create stores, write AGENTS.md, detect client
graphctx install <claude|cursor|opencode|generic|auto>
graphctx uninstall <claude|cursor|opencode|generic>
graphctx hook <event>                  # internal: called by client hooks (reads stdin)
graphctx recall "<query>" [-C <dir>] [--budget N] [--session <id>]
graphctx remember "<text>" [-C <dir>] [--subject s] [--predicate p] [--kind k]
graphctx loop "<text>" [-C <dir>] [--session <id>]
graphctx resolve <fact_id|last8> [-C <dir>]
graphctx extract [-C <dir>]
graphctx serve --mcp [-C <dir>]        # run MCP server (stdio, exactly 8 tools)
graphctx why <fact_id|last8> [-C <dir>]
graphctx doctor [-C <dir>]             # health: db, git, hooks, fact count, verdict
graphctx demo [--dir <dir>]            # one-command offline reproducible demo
graphctx tui [-C <dir>] [--tab dashboard|control|monitor]
graphctx compare [--live] [--deep] [--json] [-C <dir>]
graphctx bench [--scale|--footprint] [--sizes list] [--budget-ms N]
graphctx eval <run|memory|promote|drift|retrieval|gate|security|branch|temporal|conflict|procedure|mcp|storage|telemetry|provenance|resilience|benchmarks|cli-docs-demo|quality|all>
```

`doctor` validates: DB availability, git availability, adapter installation, Claude hook installation, Cursor/OpenCode MCP registration, generic grounding marker, and fact count. It returns a `READY` / `NOT READY` verdict that distinguishes Claude lifecycle push from static grounding plus MCP recall.

---

## 20. Security module

`security/` enforces I2/I3/I9 (GAMEPLAN §8):
- `trust.ts` — assigns `trust_tier`: structured config → `high`; prose → `low`. Hardcoded; never configurable to upgrade prose.
- `secrets.ts` — regex + entropy scan for API keys/tokens/credentials on every extracted fact and every capsule pre-send; matches → `sensitivity=secret`, excluded from promotion and injection (I3).
- `sanitize.ts` — neutralizes imperative instructions found in low-trust prose: stored/injected as *"the repo claims: …"* framing, never as a directive, never executable (allow_executable_procedures is locked `false`).

These run on **both** the write path (extraction) and the read path (pre-injection), defense in depth.

---

## 21. Telemetry & metrics

`telemetry/metrics.ts` — local-only counters/timers (never leaves machine; I config `local_only`). Tracks the metric set from PRD §13: task-level + memory-level.

`telemetry/outcomes.ts` — after each injected turn, classify the outcome by inspecting subsequent episodes: `helpful | neutral | harmful | unknown` based on signals (tool success, tests passed, user correction, repeated failed command, duplicate file read, whether a `[mem:id]` was referenced). Writes back to `injections.outcome_json`. This is the data that *later* enables learned scoring (post-v1).

---

## 22. Evaluation harness

`eval/harness.ts` runs the decisive ablation (PRD §14):

```
arms = { A: noMemory, B: pullOnly, C: push, N: negativeControl, S: staleSuppressed }
```

`eval/suites/`:
- `core-memory-lifecycle.ts` — shipped CLI remember/recall/why/open-loop lifecycle.
- `drift-gate.ts` / `gate-precision.ts` — utility-grounded event firing and injection quality.
- `retrieval-quality.ts` — recall@k / MRR / semantic + diversity probes.
- `security-adversarial.ts` — poisoning, secret, and send-edge adversarial families.
- `branch-truth.ts` — main npm vs branch pnpm.
- `compaction-recovery.ts` — long session + forced compaction (**the M0 decisive suite**).
- `parallel-conflict.ts` — two sessions, contradictory facts.
- `procedure-memory.ts` — repeated workflows.
- `adapters-mcp.ts` — client installs plus the exact 8-tool MCP surface.
- `storage-migrations.ts`, `telemetry-learning.ts`, `provenance-why.ts`, `resilience-failsoft.ts`, `eval-benchmarks.ts`, `cli-docs-demo.ts`, `code-quality.ts` — storage, learning, provenance, fail-soft, harness, CLI/docs/demo drift, and final code-quality gates.

`eval/report.ts` aggregates metrics per arm × suite and emits a table. **Gate: C must beat B** on repeated-failed-commands and post-compaction solve rate (M0 exit).

Fixtures live in `fixtures/` (sample repos + scripted transcripts) so runs are deterministic.

---

## 23. Error handling & logging

- `core/errors.ts` — typed hierarchy: `ConfigError`, `StoreError`, `GitError`, `LLMError`, `AdapterError`, `ValidationError`. Each carries a code + suggested action (structured exceptions, per Mem0 lesson).
- **Hooks never crash the agent.** Every hook handler wraps in try/catch; on any error it emits an empty capsule and logs to `~/.local/share/graphctx/logs/`. A failing graphCTX must degrade to *no memory*, never to a broken agent.
- Structured logging (level via config), with redaction of secrets in logs.

---

## 24. Performance budgets

Hard latency targets (hooks are on the agent's critical path):

| Operation | Budget |
|---|---|
| `hook <event>` total (retrieval + render) | **< 150 ms** p95 |
| Synchronous deterministic extraction | < 50 ms |
| Perishable-fact verification (per fact) | < 5 ms |
| Retrieval (multi-signal, warm) | < 80 ms |
| Capsule render | < 20 ms |
| LLM extraction | async, off critical path (no budget) |

If retrieval can't complete within budget, the planner returns the best capsule assembled so far (graceful partial). Embeddings are cached; vector index kept warm in the MCP process.

---

## 25. Testing strategy

- **Unit** (vitest, `test/` mirrors `src/`): every gate rule, relation classifier, validity rule, budgeter, renderer, trust/secret scanner. Target ≥ 85% coverage on `promote/`, `invalidate/`, `inject/`, `resolve/`, `git/` (the logic-heavy cores).
- **Integration:** real SQLite (temp file), real git repos (created in fixtures), full write→extract→promote→retrieve→inject loop.
- **Golden capsules:** snapshot tests for capsule rendering on fixed inputs.
- **Property tests:** commit-anchored validity across random DAGs (branch/merge/revert) — never leak a fact across disjoint branches.
- **Security tests:** hostile-repo fixtures (prose injection, embedded secrets) must never produce promoted/durable/executable facts.
- **Eval suites** double as end-to-end tests.

CI: lint (biome) + typecheck (tsc) + test (vitest) must pass.

---

## 26. Build & distribution

- `tsc` for type-check; bundle with `bun build` (or `tsup`) to ESM.
- Single-binary: `bun build --compile --target=<platform> src/cli.ts -o graphctx`.
- Publish `graphctx` to npm (`bin`) for `npx graphctx` usage; provide compiled binaries via GitHub Releases.
- `graphctx install claude` is the one-command onboarding (writes hooks + MCP config + AGENTS.md).

---

## 27. Implementation order

Build in dependency order; each step independently testable.

**Phase M0 — Thesis spike (prove push > pull):**
1. `core/` (types, ids, errors, clock) + `config/`.
2. `store/` (db, migrations 0001, facts/episodes repos) — no vectors yet (use BM25/FTS only).
3. `git/` (head, branch, isAncestor, validity rule).
4. `capture/` (episode log).
5. `extract/deterministic/` (all six extractors).
6. `retrieve/` (BM25 + scope filter; vectors deferred).
7. `render/` (capsule + cards + tokens).
8. `inject/planner` + `inject/gate` (SessionStart + PostCompact only) + `budget`.
9. `adapters/claude-code/` (install + hooks + AGENTS.md template).
10. `cli.ts` (init, install, hook, serve, recall).
11. `eval/harness` + `compaction-recovery` suite + `repo-drift`. **→ Run A/B/C on 5 repos. GATE.**

**Phase M1 — Memory core:** vectors (`sqlite-vec`), `invalidate/`, `promote/` (hard gates), commit anchoring full, `why`/provenance, `security/` (trust + secrets). Gate: workspace promotion precision ≥ 90%.

**Phase M2 — Full injection loop:** relevance gate (centroid drift + entity-change), channel ladder, anti-repetition ledger, `PreToolUse` micro-injection, full budgeter. Gate: harmful-injection rate < target.

**Phase M3 — Robustness:** `extract/llm/`, descriptive procedures, full conflict resolution, branch/merge/revert semantics, invalidation agent. Gate: branch-truth + parallel-conflict pass.

**Phase M4 — Multi-client:** Cursor/OpenCode adapters, proxy (Tier 4), MCP notifications (Tier 3), telemetry outcomes → groundwork for learned scoring (v2).

---

## 28. Definition of done

A module is "done" when:
- Implements its spec contract with typed interfaces.
- Unit + integration tests pass; coverage target met for logic-heavy cores.
- Respects all relevant invariants (I1–I9).
- Meets its performance budget (§24).
- Lint + typecheck clean.
- Errors are typed and hooks degrade gracefully (never crash the agent).

The **product** is MVP-done when:
- `graphctx install claude` → working push memory in one command.
- M0 gate passed (push beats pull on the compaction-recovery suite).
- M1 gate passed (promotion precision ≥ 90%).
- Security tests pass (no poisoning, no secret leakage).

---

## Invariants quick-reference

| ID | Invariant |
|---|---|
| I1 | New facts default to `candidate`, never `active` |
| I2 | Repo prose = low trust; never auto-promoted, never executable |
| I3 | Secrets/credentials never promoted, never injected |
| I4 | Perishable facts verified synchronously before injection |
| I5 | Durable writes are append-only; truth never mutated in place |
| I6 | Injection respects token budgets; optimize utility/token |
| I7 | Every injected card carries provenance `[mem:id]` |
| I8 | MCP tool surface ≤ 8 tools |
| I9 | graphCTX failures degrade to *no memory*, never a broken agent |

---

> **This spec is the contract.** Build M0 first, pass the gate, then earn each subsequent phase. The moat is the injection loop + promotion discipline — everything here serves that.

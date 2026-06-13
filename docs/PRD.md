# graphCTX — Product Requirements Document

> **A local-first memory control plane for coding agents.**
> graphCTX pushes commit-valid, scope-aware, procedurally useful context into AI coding agents at the exact lifecycle moments where they drift — instead of hoping the model remembers to ask.

| | |
|---|---|
| **Document status** | Draft v1.0 |
| **Owner** | coder-company |
| **Last updated** | 2026-06-13 |
| **Stage** | Pre-MVP / thesis validation |

---

## 0. TL;DR

AI coding agents forget. Within a long session they drift after context compaction; across sessions they start from zero — re-learning the test command, the architecture, the "don't edit generated files" rule, and the user's preferences every single time. The industry's answer is *memory you pull*: a tool the model calls when it decides to. But MCP tools are **model-controlled**, so recall becomes a compliance problem — the agent forgets to ask exactly when it most needs to remember.

**graphCTX inverts this.** It is a memory layer that **pushes** the right context into the agent at deterministic lifecycle moments (session start, post-compaction, before a tool call, on branch switch), backed by a **commit-anchored temporal knowledge store** so facts are valid *as of a git state*, not wall-clock time. Memory is organized into three scopes — **session**, **workspace**, **user** — with conservative, evidence-gated promotion between them.

The winning product is not the graph. **The winning product is the injection loop plus promotion discipline.**

> **Scope note — local-first, not a SaaS.** graphCTX is dev tooling that runs entirely on the user's machine (like `git`, an LSP, or Claude Code's own hooks). The repo, the agent, and the context window are all local, so the core loop needs no server, no API, and no network. Cloud sync / teams / remote MCP are **optional future upsells** (multi-device, collaboration, zero-install) — out of scope for the core product and gated until the local product is proven. See [future/INFRASTRUCTURE.md](future/INFRASTRUCTURE.md).

---

## 1. Problem

### 1.1 The context-loss failure modes

1. **Cross-session amnesia.** Every new session re-discovers the same facts: how to run tests, the package manager, the project layout, the user's style. Wasted tokens, wasted time, repeated mistakes.
2. **Intra-session drift via compaction.** Long-running agents hit context limits and compact. After compaction the agent has *lost its working state* — failed approaches, current plan, constraints — and doesn't even know what it forgot, so it cannot ask for it back.
3. **Pull-memory is unreliable.** Existing memory tools (MCP `recall`-style) require the model to *choose* to call them. The model routinely doesn't, precisely during long autonomous runs where drift is worst.
4. **Wall-clock memory is wrong for code.** A fact like "tests run via `npm test`" can be true on `main`, false on a migration branch, and true again after a revert. Time-based validity mismodels this; **git is the correct clock.**
5. **Eager memory poisons.** Systems that store everything inject stale or low-trust facts, degrading the agent. Bad memory is worse than no memory.

### 1.2 Who has this problem

- Developers using Claude Code, Cursor, OpenCode and similar agents on real repos over days/weeks.
- Teams running long-horizon autonomous coding tasks (refactors, migrations) that exceed a single context window.
- Anyone whose agent repeats a known-bad command, edits a generated file, or ignores a documented convention.

### 1.3 Why now

- MCP has matured into a near-universal integration surface, and clients (Claude Code) now expose **deterministic lifecycle hooks** — a real *push* surface that didn't exist before.
- Temporal-KG techniques (OpenAI's temporal-agents cookbook, Zep/Graphiti's bi-temporal model) are proven; the gap is **delivery**, not storage.
- The 2026 memory benchmarks (LoCoMo, LongMemEval, BEAM) show temporal reasoning and scale are the hardest open problems — and that naive context accumulation *hurts* (BEAM drops ~25% from 1M→10M tokens). This validates a *selective, pushed* approach over dump-everything.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- **G1 — Prove push > pull.** Demonstrate measurably that proactively injected context reduces drift more than tool-based recall, on real coding tasks with forced compaction.
- **G2 — Commit-valid memory.** Facts carry git validity (`valid_from_commit` / `valid_until_commit`); recall returns truth *as of the current checkout*.
- **G3 — Three-scope memory with conservative promotion.** session → workspace → user, gated on evidence, never auto-promoting low-trust or unverified facts.
- **G4 — Local-first, zero-friction.** Single install, single binary feel, no external database, private by default.
- **G5 — Multi-client via an adapter ladder.** Strongest available push per client, graceful degradation.
- **G6 — Never poison.** Strict token budgets, trust tiers, provenance, and pre-injection verification of perishable facts.

### 2.2 Non-Goals (v1)

- Hosted/cloud sync, team graphs, multi-tenancy.
- A full graph database or multi-hop graph traversal (deferred until proven to improve injection).
- Auto-executing stored procedures (`safe_to_autorun`) — procedures are **descriptive only** in v1.
- Automatic workspace→user inference (v1 requires explicit user intent for global facts).
- Perfect support for every client; Claude Code is the reference adapter.
- Learned/ML-tuned scoring — v1 uses **hard gates and deterministic rules**, not hand-weighted polynomials.

---

## 3. Thesis & Strategy

> **MCP tools are model-controlled, so recall is a compliance problem. graphCTX manufactures deterministic *push* out of the agent lifecycle, and persists truth in a commit-anchored temporal store with disciplined promotion.**

Strategic consequences:
- **Invest in the injection loop and promotion discipline.** Storage is commodity; a flat temporal fact table is sufficient for v1.
- **Beachhead on compaction recovery.** Post-compaction is where pull fails hardest (agent can't ask for what it forgot) and push wins cleanest (empty space to fill, maximal marginal value).
- **The relevance gate is the invention.** Deciding *when* and *what* to inject — without poisoning — is the genuine research problem. The channel plumbing is engineering.

---

## 4. Users & Use Cases

### 4.1 Primary persona — "Long-haul Dev"
Runs an agent on the same repo for weeks. Pain: re-teaching the agent the same things; agent breaks conventions after compaction. Wants: the agent to "just know" the repo and their preferences, durably and correctly.

### 4.2 Key use cases

- **UC1 — Boot grounding.** On session start, the agent receives a compact capsule: repo conventions, canonical commands, generated-code boundaries, user static preferences.
- **UC2 — Compaction recovery.** After compaction, the agent is re-grounded with the distilled session state: current plan, failed attempts (and why), touched files, active constraints.
- **UC3 — Pre-tool guardrail.** Before a Bash/Edit, the agent receives the relevant micro-context (e.g., "this repo uses pnpm, not npm"; "do not edit `src/generated/*`").
- **UC4 — Branch-aware truth.** On branch switch, recall recomputes which facts are valid as of the new HEAD.
- **UC5 — Provenance & control.** The user can inspect why a fact exists, edit/forget it, and resolve conflicts.

---

## 5. Product Overview

graphCTX ships as:
1. **A CLI** (`graphctx`) — init, serve, install adapters, recall/remember/promote/forget/why, time-travel, eval.
2. **An MCP server** — exposes a small, deliberate tool surface (recall is *available* but not the primary path).
3. **An adapter layer** — installs client-specific push surfaces (Claude Code hooks first) and degrades gracefully.
4. **A local temporal store** — SQLite, commit-anchored facts + an append-only episode log.

### 5.1 Three-tier memory model

| Tier | Scope key | Holds | Lifetime |
|---|---|---|---|
| **Session** | `session_id` | Working state: plan, failed attempts, transient decisions, task state | Ephemeral; distilled at session end |
| **Workspace** | `workspace_id` (repo) | Durable project truth: commands, conventions, architecture, decisions, generated-code boundaries — commit-anchored | Long-lived, per project |
| **User** | `user_id` | Cross-project preferences/habits/style. Split into **static** (stable) and **dynamic** (recent focus) | Permanent, follows the user |

Effective context for a turn is a **layered composition** of user + workspace (valid as of HEAD) + session, with explicit precedence and conflict representation — facts never silently overwrite each other.

---

## 6. The Injection System (the core)

### 6.1 Channel taxonomy (delivery surfaces)

Push must be manufactured from surfaces that vary by client. graphCTX uses a **capability-detected ladder**, routing the *same capsule* through the strongest available channel:

| Tier | Channel | Timing | Determinism | Notes |
|---|---|---|---|---|
| **0 — Floor** | `AGENTS.md` / `CLAUDE.md` boot capsule + recall directive | Session start only | High at boot, none mid-session | Universal; **not** the answer, just grounding |
| **1 — Parasitic** | Rider context appended to *every* MCP tool response | Opportunistic (when agent calls any tool) | Medium | Every interaction becomes a re-grounding opportunity |
| **2 — Real push** | Lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`) | Precise, event-driven | Maximal — model cannot decline | **Crown jewel.** Claude Code reference adapter |
| **3 — Future push** | MCP server-initiated notifications / elicitation | Anytime | High *if* client honors it | Bet directionally; don't depend on it |
| **4 — Nuclear fallback** | Proxy/interception layer rewriting outgoing context | Every turn | Absolute | Works on hookless clients; invasive, security-sensitive |

The adapter abstraction: *given client X, select the highest push tier available and route the capsule.*

### 6.2 Relevance gate (the invention)

A deterministic moment (`PreToolUse`) is not a relevance signal. Firing on every event poisons context. graphCTX gates injection on a cheap, fast signal:

- **Topic-centroid drift** — embedding distance from a rolling task centroid exceeds threshold.
- **Entity-change detection** — new files/symbols/packages mentioned vs. last injection.
- **Event class** — `PostCompact` and `SessionStart` always fire; `PreToolUse` fires only when memory plausibly applies to the planned tool/args.
- **Anti-repetition ledger** — per-session record so a recently-injected fact isn't re-injected across channels.

### 6.3 Capsule rendering

The capsule competes with the task for context budget; rendering matters as much as delivery. Requirements:
- Compact, source-tagged (`[mem:123]`), action-shaped.
- Sectioned: Task state · Repo constraints · Applicable procedure · User preferences · Conflict notes.
- Hard token caps per event type (see §9).

### 6.4 Beachhead: compaction recovery

`PostCompact` is the first surface to prove value: pull fails hardest (the agent can't request what it no longer knows it lost) and push wins cleanest. The compaction-recovery capsule re-establishes plan, failed attempts, constraints, and next step.

---

## 7. Memory Model & Temporal Logic

### 7.1 Fact (conceptual)

A fact is a temporal triplet `[subject] — [predicate] — [object]` plus:
- **kind**: `semantic | episodic | procedural | preference | decision | constraint | failure | task_state`
- **temporal_kind**: `atemporal | static | dynamic`
- **scope**: `{ user_id, workspace_id?, session_id? }`
- **lifecycle**: `status` (`candidate | active | expired | superseded | disputed | rejected`), `promotion_state`
- **git anchor**: `repo_id, branch, valid_from_commit, valid_until_commit, invalidated_by_commit, path_globs, …`
- **source / provenance**: `asserted_by` (`user | agent | tool | deterministic_parser | llm_extractor | git_watcher`), event ids, commit, raw quote
- **trust tier** (see §8.3), **sensitivity** (`public | private | secret | credential`), **confidence**, **tags**

### 7.2 Commit-anchored validity

- Facts attach to the git DAG. Recall filters to facts whose `[valid_from_commit, valid_until_commit]` window contains the current HEAD (by ancestry).
- **Branch divergence** → facts are branch-scoped, not leaked across branches.
- **Revert** → re-validates the prior fact; **merge** → recompute against the merge commit tree.
- `graphctx time-travel --commit <sha> recall "test command"` returns truth as of any commit.

### 7.3 Invalidation

Source hierarchy: **hard** (config/file/symbol deleted, script removed, revert detected, user says "wrong") → **strong** (CI/dependency/branch change) → **soft** (conflicting newer observation, repeated non-use). Deterministic checks first; an LLM invalidation agent only as a fallback, and it must cite evidence — it may **never** invalidate based on general world knowledge.

### 7.4 Staleness

Perishable (procedural) facts are **verified synchronously before injection** — checking that a path/script/symbol still exists is microseconds, so do it every time rather than relying on a heuristic risk score. A confidently-wrong injected command is the worst user-facing failure; verification is mandatory, not probabilistic.

---

## 8. Promotion Discipline

### 8.1 Principle
Default state of any extracted fact is `candidate`, not `active`. Promotion is conservative, evidence-gated, and inspectable. **v1 uses hard gates, not weighted scoring.**

### 8.2 Promotion gates (v1)

**Session → Workspace** — promote when:
- User explicitly states a repo-scoped fact, **or**
- Deterministic repo evidence exists (package script, `.editorconfig`, lockfile, CI config, generated-file marker), **or**
- A command/procedure succeeded ≥ 2× (verified), **or**
- A failure/constraint repeated across ≥ 2 sessions.
Never promote: secrets/credentials, `task_state`, disputed facts, agent-only inferred architecture without file evidence.

**Workspace → User** — promote only when:
- User explicitly says "always" / "I prefer this globally."
- **No automatic inference in v1.** (Cross-project inference is a v2 experiment.)
Repo conventions are **never** promoted to user preferences just because the user tolerated them.

### 8.3 Trust tiers (anti-poisoning)
- **High trust** — structured config the repo enforces: `package.json` scripts, lockfiles, `.editorconfig`, CI configs, compiler/linter config.
- **Low trust** — free-text repo prose: `AGENTS.md`/`README`/code comments. May be injected as *"the repo claims X,"* but **never auto-promoted to durable**, and **never anything executable.**

This directly defends against **persistent prompt injection**: a hostile repo's prose could otherwise become a promoted, silently re-injected, durable instruction across sessions. Trust tiering + "no executable from prose" neutralizes that.

### 8.4 Conflict & precedence
Precedence (high→low): safety/permissions → current-session explicit user instruction → repo *structured* evidence at HEAD → workspace durable decision → user static → user dynamic → older session → agent inference. (Note: repo *prose* is **not** high in this order — only structured evidence is.)

Parallel sessions writing contradictory workspace facts use **append-only writes with optimistic concurrency** (each write carries `base_git_head`): branch-disjoint → branch-scope both; deterministic winner → invalidate loser; otherwise → mark **disputed** (never silent last-writer-wins). Injection surfaces a conflict note rather than silently choosing.

---

## 9. Token Budgets

| Event | Budget |
|---|---|
| Total injection per turn | min(2500 tokens, ~1.5% of context window) |
| SessionStart | 1200–2000 |
| UserPromptSubmit | 800–1800 |
| PreToolUse | 200–450 |
| PostToolUse (failure recovery) | 300–700 |
| PostCompact | 2000–3500 |
| Per fact card | ≤ 250 |
| Max cards | 15 normal / 5 pre-tool |

Selection optimizes **marginal utility per token** with a diversity/redundancy penalty — not recall volume (BEAM shows volume hurts).

---

## 10. Interfaces

### 10.1 MCP tool surface (small by design)
`remember` · `recall` · `inject_context` · `checkpoint_session` · `promote` · `forget` · `why` · `resolve_conflict`

- `inject_context` is the important one — called by adapters/hooks, not usually the model.
- `recall` exists for pull fallback but is explicitly *not* the primary path.
- Keep the surface ≤ 8 tools (tool count is itself a context-budget cost).

### 10.2 CLI surface
```
graphctx init                      # set up store + write AGENTS.md capsule
graphctx serve --mcp               # run MCP server
graphctx install claude|cursor|opencode
graphctx remember "<fact>" --scope workspace
graphctx recall "<query>" --workspace . --budget 1000
graphctx inject --event PostCompact --session <id>
graphctx checkpoint --session <id>
graphctx promote pending --workspace .
graphctx promote fact <id> --to user-static
graphctx forget <id> --expire --reason "..."
graphctx profile show|edit|diff
graphctx conflicts list|resolve <id>
graphctx why fact <id> | why injection <id>
graphctx time-travel --commit <sha> recall "<query>"
graphctx doctor
graphctx eval run --suite repo-drift
```

---

## 11. Architecture

```
        Claude Code / Cursor / OpenCode
         pull (MCP tools) │ push (hooks / rules / channels / proxy)
                          ▼
                  Adapter Layer
   (MCP server · hooks installer · rules injector · transcript &
    git-state capture · tool-call event stream · capability ladder)
            │                              │
            ▼                              ▼
   Hot Injection Planner          Append-only Episode Log
   (trigger gate · retrieval ·    (prompts · tool calls/results ·
    conflict resolve · budget ·    file changes · compaction events ·
    capsule render)                user corrections)
            │                              │ async
            ▼                              ▼
   Injection Capsule              Extraction / Distillation Jobs
                                  (deterministic parsers · LLM fact
                                   extractor · procedure miner ·
                                   invalidation agent · promotion gate)
                          │
                          ▼
                 Temporal Store (SQLite)
        SESSION graph · WORKSPACE graph (commit-anchored) · USER graph
                          ▲
                          │
                     Git Watcher
   (HEAD/branch/worktree · commit DAG reachability · merge/rebase/
    revert detection · file-rename tracking · patch-id remapping)
```

**Write path:** event → episode log → deterministic extractors (sync, cheap) → LLM extractors (async, batched) → invalidation → candidate → promotion gate.
**Read/inject path:** trigger → gather (transcript tail, prompt, files/symbols, planned tool, git state, budget) → multi-signal retrieval (semantic + keyword + entity) composed across scopes → conflict resolution → budgeted capsule → deliver via highest available channel.

---

## 12. Tech Choices

- **Language: TypeScript.** The integration ecosystem (official MCP SDK, Claude Code hooks, `better-sqlite3`, `simple-git`) is TS-native; the workload is I/O/LLM-bound, not CPU-bound. Single-binary distribution via `bun build --compile`.
- **Storage: SQLite** (WAL) + **FTS5** (BM25) + an embedded vector index (e.g. `sqlite-vec`) + adjacency tables for shallow graph walks. One file per scope; private by default. **No required external DB.**
- **Git: `simple-git` / libgit2 bindings** for DAG reachability and state.
- **Do not build on existing infra** (Graphiti/MemoryGraph runtimes). Learn from their temporal lessons; own the runtime to guarantee the single-binary, push-first experience.

### 12.1 Storage layout
```
~/.local/share/graphctx/user.db
<workspace>/.graphctx/workspace.db   (opt-in; else hashed under ~/.local/share)
<workspace>/.graphctx/episodes.jsonl
```

---

## 13. Success Metrics

### 13.1 North-star
**Drift reduction from push vs. pull** on real coding tasks with forced compaction.

### 13.2 Task-level
solve rate · tests pass rate · wall-clock time · tool-call count · **failed** tool-call count · duplicate file reads · **repeated failed commands** · user-correction count.

### 13.3 Memory-level
injection hit rate · **harmful-injection rate** · stale-injection rate · avg injected tokens · **marginal utility per token** · facts-used-per-injection.

### 13.4 Promotion quality (human-labeled weekly)
- Workspace promotion precision ≥ **90%**
- User-static precision ≥ **95%**
- User-dynamic precision ≥ **90%**
- Recall may lag initially — *missing memory is cheaper than wrong memory.*

---

## 14. Evaluation Plan

### 14.1 Adapt existing benchmarks
LoCoMo / LongMemEval (long-horizon recall, temporal), BEAM (scale degradation), SWE-bench Verified (does memory help real task success), RepoBench (repo-level retrieval). None are coding-memory-complete — hence custom suites.

### 14.2 Custom coding suites
1. **Repo-drift** — command changes across commits; measure stale-injection rate, correct-command selection, generated-file violation rate.
2. **Branch-truth** — `main` uses npm, branch migrates to pnpm; measure commit-valid recall accuracy, branch-leakage rate.
3. **Compaction-recovery** — long session, forced compaction; measure repeated-failed-attempt rate, task-state recovery, post-compaction solve rate.
4. **Parallel-agent conflict** — two sessions write contradictory facts; measure silent-wrong-winner rate, disputed precision.
5. **Procedure memory** — repeated migration/codegen/release; measure extraction precision, reuse success, verifier correctness.

### 14.3 Ablation (the decisive test)
Run every suite across: **A** no memory · **B** pull-only MCP recall · **C** push without graph · **D** graph without push · **E** push+graph without promotion · **F** without commit anchors · **G** without procedural memory · **H** full system.

> The decisive comparison is **B (pull) vs C (push)**. If push does not beat pull, the thesis is wrong — and we learn that *first*, cheaply.

---

## 15. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 — Thesis spike** | Claude hooks dump transcript+git → SQLite; deterministic extractors only; SessionStart + PostCompact injection; hand-built capsule | A/B/C eval on 5 repos: does **C beat B** on repeated-failed-commands & post-compaction solve? |
| **M1 — Memory core** | Conservative promotion (hard gates), commit anchoring, three scopes, `why`/provenance | Workspace promotion precision ≥ 90% on labeled set |
| **M2 — Full injection loop** | Relevance gate, channel ladder, anti-repetition ledger, capsule renderer, budgets | Harmful-injection rate < target; marginal-utility-per-token positive |
| **M3 — Robustness** | LLM extraction, descriptive procedures, conflict resolution, branch/merge/revert semantics | Branch-truth & conflict suites pass |
| **M4 — Multi-client** | Cursor/OpenCode adapters, proxy fallback, MCP notifications where supported | Push tier auto-detected per client |

---

## 16. Risks & Open Problems

**Genuinely hard / unsolved:**
- **Temporal abstraction at scale** — compressing many events into durable abstractions without losing temporal distinctions (BEAM 1M→10M ≈ 25% drop).
- **Staleness of high-confidence facts** — confidence ≠ freshness; mitigated by git validity + synchronous pre-injection verification, not fully solved.
- **Cross-session identity resolution** — "auth module" vs "login service" vs `src/server/auth` across refactors; deterministic file/symbol anchors help, conceptual aliases remain hard.
- **Context poisoning** — stale/low-trust/irrelevant injection can make the agent worse; mitigated by budgets, trust tiers, provenance, repo-evidence precedence, harmful-injection tracking.
- **Persistent prompt injection** — hostile repo prose becoming durable instructions; mitigated by trust tiers + "no executable from prose" + no auto-promotion of prose.
- **Parallel-agent branch-scoped truth** — append-only + base-git-head + disputed state instead of silent winner.
- **Relevance gating** — *when/what to inject* is the core invention and the main research risk.

**Solved engineering (just build well):** append-only logs, bi-temporal fields, git DAG reachability, SQLite storage, hybrid retrieval, MCP surface, Claude hooks, provenance display, deterministic config extraction, token budgeting.

### Riskiest assumption to validate first
> **Pushed memory capsules reduce drift more than they poison context.**
Validate via M0's A/B/C eval before building graph/promotion infrastructure. If push doesn't beat pull, the product thesis is weak.

---

## 17. Positioning

Not pitched as *"a temporal-KG memory server"* — that space exists (Mem0, Zep/Graphiti, Supermemory, MemoryGraph). graphCTX is:

> **A local-first memory control plane for coding agents that pushes commit-valid, scope-aware, procedurally useful context at the exact lifecycle moments where agents drift.**

The moat is the **injection loop + promotion discipline**, not the storage.

---

## Appendix A — Glossary
- **Capsule** — the rendered context block injected into the agent for one event.
- **Commit anchor** — git validity window attached to a fact.
- **Promotion** — graduation of a fact across scopes (session→workspace→user).
- **Relevance gate** — the decision of whether/what to inject at a deterministic moment.
- **Trust tier** — provenance-based trust level governing promotion & executability.
- **Channel ladder** — capability-detected stack of delivery surfaces per client.

## Appendix B — Prior art accounted for
OpenAI *Temporal Agents with Knowledge Graphs* cookbook (temporal classification, invalidation agent) · Zep/Graphiti (bi-temporal, episodes) · Mem0 (multi-scope, multi-signal retrieval, async writes, named open problems) · Supermemory (static/dynamic profiles, container tags) · MemoryGraph (coding-agent MCP memory, bi-temporal, context-budget tool pruning). graphCTX's differentiation is **push-first delivery + commit-anchored validity + disciplined promotion**, not storage novelty.

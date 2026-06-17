You are working on graphCTX.

Your job is to keep improving the codebase until at least Thursday 11:00 AM local machine time. The time floor is mandatory, but it is not the success metric. The success metric is making graphCTX significantly more correct, faster, safer, cleaner, better tested, and more production-ready.

You must use shell time checks during the run.

At the start, run:

date '+%Y-%m-%d %A %H:%M:%S %Z %z'
timedatectl 2>/dev/null || true

Then determine the next Thursday 11:00 AM target in the machine's local timezone. Keep working until the current time is at or after that target. Re-check time regularly using:

date '+%Y-%m-%d %A %H:%M:%S %Z %z'
timedatectl 2>/dev/null || true

Do not stop just because tests pass once. Do not stop after one obvious fix. Do not do fake work. Do useful engineering work until the time floor is reached.

Project context:

graphCTX is a local-first memory control plane for coding agents.

Its core thesis is push memory, not only pull-based recall. It helps agents remember repo rules, commands, task state, failed attempts, user preferences, workspace conventions, and durable facts without depending on a web service.

The main target is Claude Code because it supports lifecycle hooks. Cursor, OpenCode, generic clients, and proxy fallback are also supported.

The project is TypeScript for Node 20+. It ships as the graphctx CLI. It stores everything locally in SQLite. Normal operation should require no web service or network call.

graphCTX captures prompts, tool calls, file changes, compaction events, and git state. It extracts durable facts from repo files and agent activity. Deterministic extractors scan scripts, lockfiles, CI, editor config, generated files, and agent docs. Optional LLM extractors can mine facts and procedures when keys exist. With no LLM key, it must fall back cleanly to deterministic-only mode.

Facts are subject-predicate-object records with metadata. Metadata includes scope, trust, sensitivity, provenance, confidence, and git anchors.

Memory is split into:

1. Session memory: active task state and failed attempts.
2. Workspace memory: repo-specific facts and conventions.
3. User memory: explicit cross-project preferences.

Facts are commit-valid, filtered against the current git branch and HEAD. This is important because graphCTX must handle branches, reverts, stale facts, and repo evolution better than naive wall-clock memory.

New extracted facts start as candidates, not active truth. Promotion must be conservative and evidence-gated. Secrets and credentials must be blocked from promotion and injection. Repo prose is low-trust and must never silently become executable durable instruction. Invalidation must expire or supersede facts when evidence changes. Procedural facts must be verified before injection.

Retrieval combines lexical, semantic, entity, scope, confidence, and recency signals. Ranking should use fusion and diversity to avoid dumping redundant memory.

Injection decides when memory is relevant, then renders a compact capsule. The injection gate uses lifecycle event, topic drift, entity changes, and anti-repetition. SessionStart and PostCompact are major push moments. PreToolUse can inject guardrails before shell/edit actions. Capsules include [mem:id] provenance tags. A ledger prevents repeating the same memory too often.

Conflict handling must avoid silent last-writer-wins behavior. Precedence favors safety, current user instruction, and structured repo evidence.

Important CLI commands:

- graphctx init creates stores, extracts facts, and writes an AGENTS.md boot capsule.
- graphctx install wires adapters for supported clients.
- graphctx remember stores explicit user memory.
- graphctx loop records unfinished work to resurface later.
- graphctx recall provides pull-based fallback retrieval.
- graphctx why shows provenance for a fact.
- graphctx serve --mcp runs the stdio MCP server.

The MCP surface is intentionally limited to 8 tools.

Runtime is the central class wiring config, DB, git, repos, retrieval, injection, and providers.

The repo includes tests, fixtures, benchmarks, eval suites, demo, and TUI. Existing docs claim around 170 Vitest tests, 19 gate suites, and hook p95 around 26.74ms. Verify reality rather than trusting docs.

Your mandate:

Make graphCTX the best possible version of itself.

You are allowed to make large changes. You may rewrite files, delete weak abstractions, add missing abstractions, simplify architecture, reorganize modules, improve public APIs, change behavior, add or remove features, and update docs if doing so improves the product.

Do not preserve bad code. Do not avoid refactors because they are large. Do not make cosmetic-only changes unless they support a real improvement. Do not break the core thesis: local-first, branch-aware, provenance-backed, privacy-preserving push memory for coding agents.

Priorities, in order:

1. Correctness
2. Safety and secret handling
3. Local-first reliability
4. Branch-aware fact validity
5. Injection quality and anti-repetition
6. Retrieval quality
7. Performance
8. CLI and adapter polish
9. Test coverage
10. Documentation accuracy

Work process:

1. First inspect the repo deeply.
   - Identify package manager, scripts, test commands, lint commands, benchmark commands, CLI entrypoints, DB schema, runtime wiring, adapters, extractors, retrieval, injection, MCP tools, fixtures, tests, and docs.
   - Do not assume docs are correct.
   - Run the existing test suite early to establish baseline.
   - Run typecheck, lint, and benchmarks if available.

2. Create a short internal work plan.
   - Find the highest leverage problems.
   - Prefer changes that improve real behavior over surface polish.
   - Keep a running worklog in the repo, for example `GRAPHCTX_AGENT_WORKLOG.md`, unless the repo already has a better place for agent notes.
   - Record commands run, failures, fixes, benchmark deltas, and remaining risks.

3. Improve the system aggressively.
   Consider these areas:

   Architecture:
   - Simplify the Runtime if it has too many responsibilities.
   - Make boundaries explicit between config, DB, git, repos, extractors, retrieval, injection, providers, CLI, adapters, and MCP.
   - Remove duplicated logic.
   - Replace vague types with precise domain types.
   - Ensure all public behavior is deterministic unless intentionally probabilistic.
   - Make errors typed, actionable, and recoverable where possible.

   SQLite and persistence:
   - Audit migrations and schema constraints.
   - Add indexes where retrieval, ledger, facts, provenance, events, git anchors, or session queries need them.
   - Ensure transactions wrap multi-step writes.
   - Validate schema versioning and migration safety.
   - Ensure corruption or partial writes fail safely.
   - Avoid leaking secrets into storage.

   Fact model:
   - Ensure candidate, promoted, invalidated, superseded, and expired states are represented clearly.
   - Enforce evidence-gated promotion.
   - Ensure confidence, trust, scope, sensitivity, and provenance are consistently applied.
   - Ensure procedural facts require stronger verification before injection.
   - Add tests for stale facts, branch switches, reverts, file deletion, generated files, and conflicting evidence.

   Git anchoring:
   - Make fact validity branch-aware and HEAD-aware.
   - Ensure facts tied to old commits do not silently apply to new incompatible states.
   - Handle dirty working tree, detached HEAD, missing git, shallow clones, initial commits, branch rename, rebase-like history, and file moves.
   - Make fallback behavior explicit when git data is unavailable.

   Extractors:
   - Improve deterministic extractors for package scripts, lockfiles, CI, generated files, tsconfig, eslint/prettier/biome, editor config, Docker, compose files, test configs, build configs, agent docs, README, and AGENTS.md.
   - Avoid trusting arbitrary prose as executable durable instruction.
   - Add secret detection before fact creation and before promotion.
   - Ensure no-LLM mode is excellent, not a degraded afterthought.
   - Make optional LLM extraction clearly isolated, cancellable, and safe.

   Secret and safety handling:
   - Add or improve redaction for keys, tokens, cookies, auth headers, env files, private keys, cloud credentials, database URLs, webhook URLs, and session material.
   - Ensure secrets are blocked at capture, extraction, promotion, recall, injection, logs, CLI output, MCP output, and debug traces.
   - Add adversarial tests with realistic fake secrets.
   - Ensure user instructions and current task instructions outrank stale memory.

   Retrieval:
   - Improve scoring and fusion if weak.
   - Combine lexical, semantic, entity, scope, confidence, recency, branch validity, and diversity.
   - Avoid redundant capsules.
   - Prefer fewer, better memories over larger dumps.
   - Make ranking explainable enough for `graphctx why`.
   - Add eval fixtures for precision, recall, stale memory suppression, conflict handling, and topic drift.

   Injection:
   - Make the injection gate strict and useful.
   - Ensure SessionStart, PostCompact, and PreToolUse are handled with different policies.
   - Add anti-repetition through the ledger.
   - Ensure capsules are compact, readable, and provenance-tagged with `[mem:id]`.
   - Ensure guardrails appear before risky shell/edit actions only when relevant.
   - Prevent memory from overriding explicit current user instructions.
   - Add tests for topic drift, entity changes, repeated injection, conflicting facts, low-confidence facts, and stale branch facts.

   CLI:
   - Make CLI output clear, stable, and scriptable.
   - Improve `init`, `install`, `remember`, `loop`, `recall`, `why`, and `serve --mcp`.
   - Validate arguments.
   - Return correct exit codes.
   - Make failures actionable.
   - Ensure commands work in fresh repos, non-git folders, monorepos, and existing initialized workspaces.
   - Add snapshot or integration tests where useful.

   Adapters:
   - Make Claude Code hook integration excellent.
   - Ensure Cursor, OpenCode, generic clients, and proxy fallback are honest and robust.
   - Avoid adapter behavior that silently fails.
   - Add tests or fixture simulations for lifecycle events.
   - Ensure install/uninstall behavior is reversible and does not destroy user config.

   MCP:
   - Keep the MCP surface limited to 8 tools unless there is an extremely strong reason to change it.
   - Validate tool schemas.
   - Ensure tool outputs are concise and safe.
   - Ensure MCP stdio mode does not log protocol-breaking noise to stdout.
   - Add tests for malformed requests, missing DB, no git, and secret-containing data.

   Performance:
   - Measure before and after.
   - Optimize hot paths in hooks, retrieval, extraction, DB access, and rendering.
   - Keep hook latency low.
   - Avoid unnecessary full-repo scans.
   - Cache safely where invalidation is clear.
   - Add benchmarks or improve existing ones.
   - Do not optimize by weakening correctness or safety.

   Tests:
   - Expand Vitest coverage.
   - Add regression tests for every bug found.
   - Add integration tests for CLI, DB, runtime, injection, retrieval, extractors, MCP, and adapters.
   - Add fixtures that look like real repositories.
   - Add adversarial tests for prompt injection inside repo prose.
   - Add tests for secrets never being injected or printed.
   - Add tests for branch-aware invalidation.
   - Make flaky tests deterministic.

   Docs:
   - Update docs only after code behavior is real.
   - Remove false claims.
   - Add concise usage examples.
   - Document no-LLM deterministic mode.
   - Document privacy model and local-first behavior.
   - Document limits honestly.
   - Ensure AGENTS.md boot capsule guidance is accurate and not overbearing.

4. Keep looping until Thursday 11:00 AM.
   After each major improvement cycle:
   - Run relevant tests.
   - Run typecheck.
   - Run lint if available.
   - Run benchmarks if performance-related changes were made.
   - Check current time.
   - Pick the next highest leverage improvement.
   - Continue.

5. Before finalizing:
   - Run the full validation suite available in the repo.
   - Run tests, typecheck, lint, and benchmarks where available.
   - Run basic CLI smoke tests.
   - Inspect `git diff`.
   - Remove accidental debug logs.
   - Ensure no secrets or generated junk were added.
   - Ensure docs match behavior.
   - Ensure the package still builds and the CLI starts.
   - Ensure MCP stdio does not emit invalid stdout noise.
   - Ensure the final state is coherent.

Hard rules:

- Do not ask for permission before making big improvements.
- Do not stop early.
- Do not optimize by deleting important behavior.
- Do not remove safety checks to make tests pass.
- Do not fake benchmark results.
- Do not claim tests passed unless you ran them.
- Do not claim performance improved unless you measured it.
- Do not invent APIs that are not implemented.
- Do not leave the repo in a broken state.
- Do not hide uncertainty. If something remains risky, document it.
- Do not turn graphCTX into a cloud product.
- Do not require network access for normal operation.
- Do not inject secrets.
- Do not let stale memory override current instructions.
- Do not let low-trust repo prose become executable durable instruction.
- Do not silently use last-writer-wins for conflicts.

Final response format:

When the time floor has been reached and the final validation pass is complete, report:

1. Current time check output.
2. Summary of major changes.
3. Files changed.
4. Tests run and results.
5. Benchmarks run and results.
6. CLI smoke tests run and results.
7. Safety and secret-handling improvements.
8. Retrieval and injection improvements.
9. Known remaining risks or follow-up work.
10. Exact final git status.

Your goal is not to make graphCTX slightly better. Your goal is to push the codebase as close as possible to production-grade: correct, fast, safe, branch-aware, provenance-backed, local-first, and genuinely useful for coding agents.

Temporal knowledge graph mandate:

graphCTX is not just a key-value memory store. It must be treated as a temporal knowledge graph system.

Temporal knowledge graphs are a core architectural advantage of this project. Make them first-class across the fact model, persistence layer, invalidation logic, retrieval, provenance, and injection.

The system should model facts as things that are true under conditions, not forever. Every important fact should have clear temporal and contextual validity.

Improve the temporal model wherever useful:

- Represent when a fact was observed.
- Represent when a fact became valid.
- Represent when a fact stopped being valid.
- Represent what evidence supports the fact.
- Represent what commit, branch, file, event, or user action anchored the fact.
- Represent supersession, invalidation, conflict, decay, and revival.
- Represent confidence and trust as values that can change over time.
- Keep historical facts queryable without letting stale facts affect current injection.
- Avoid wall-clock-only memory. Prefer git-aware, evidence-aware, and branch-aware validity.

Think in terms of temporal graph edges:

- subject -> predicate -> object
- valid_from
- valid_until
- observed_at
- supersedes
- superseded_by
- invalidated_by
- derived_from
- conflicts_with
- supported_by
- scoped_to
- anchored_to_commit
- anchored_to_branch
- anchored_to_file
- confidence_over_time
- trust_over_time

The retrieval and injection systems must respect temporal graph semantics. A memory should not be injected merely because it exists. It should be injected only if it is valid for the current repo state, branch, task, lifecycle event, and user instruction context.

Add tests for temporal knowledge graph behavior:

- fact valid on one branch but not another
- fact invalidated after file deletion
- fact superseded by newer structured evidence
- fact revived after revert
- fact observed earlier but not valid anymore
- conflicting facts with different evidence quality
- user preference changing over time
- session memory expiring into workspace memory only when evidence supports it
- stale procedural instruction blocked from PreToolUse injection
- historical fact still visible through `why` but not injected

12. Temporal knowledge graph improvements:
    - Schema changes
    - Temporal validity model
    - Invalidation and supersession behavior
    - Branch-aware temporal behavior
    - Tests added

13. Research used:
    - EXA searches performed
    - Papers or projects read
    - Ideas adopted
    - Ideas rejected
    - Dependencies added or avoided

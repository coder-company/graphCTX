# graphCTX — Implementation Status

> Living checklist mapping every SPEC module to its build status. Updated at each
> phase boundary. Legend: ✅ done · 🟡 partial · ⬜ missing.

| Phase | Branch | Gate | Status |
|---|---|---|---|
| M0 — thesis spike | `m0-spike` | push beats pull | ✅ PASS (C 100% vs B 21%) |
| M1 — memory core | `m1-finish` | promotion precision ≥ 90% | ✅ PASS (100% precision/recall, 0 leaks) |
| M2 — injection loop | `m2-injection` | harmful-injection < target + selective gate | ✅ PASS (0 harmful, 31% PreToolUse fire-rate, 0 dupes) |
| M3 — robustness | `m3-robustness` | branch-truth + parallel-conflict + procedure pass | ✅ PASS (0 leaks, 0 silent winners, safe LLM extraction) |
| M4 — adapters + MCP | `adapters-mcp` | install per client + MCP contract + secure proxy | ✅ PASS (88/88; MCP=8 tools; 0 proxy leaks) |

## Module status (SPEC §2 layout)

| Module | SPEC § | Status | Notes |
|---|---|---|---|
| core/ (types, ids, errors, clock) | §7 | ✅ | open_loop kind added; signals extended (confidence/recency) |
| config/ (schema, defaults, load) | §5 | ✅ | zod-validated; PostToolUse enabled |
| store/db + migrations | §6 | ✅ | 0001 init, 0002 M1 (embedding_cache/promotions), 0003 M2 (inject_ledger), 0004 observation time, 0005 fact query indexes, 0006 invalidation conflict lookup index; storage gate covers forward migrations, pragmas, corruption recovery |
| store/facts.repo | §6.2 | ✅ | append-only (I5); sensitivity auto-stamp; openLoops() |
| store/episodes.repo | §9 | ✅ | append + tail (drift window) |
| store/edges.repo | §6 | ✅ | SUPERSEDES/INVALIDATES/CONFLICTS_WITH/OVERRIDES/SUPPORTED_BY/SUPERSEDED_BY |
| store/promotions.repo | §12 | ✅ | audit trail (powers why()) |
| store/injections.repo | §21 | ✅ | logs selected/rejected/tokens; outcome_json feeds local learned ranking |
| store/entities.repo | §6 | ⬜ | deferred — entity scoring already in retriever; M1 recall 100%, no measured benefit (honest skip) |
| store/procedures.repo | §6 | ✅ | full CRUD; descriptive-only (D10); success/failure tracking |
| git/git + anchors | §8 | ✅ | head/branch/isAncestor/validity; anchorAtHead; branch filter; parentsOf/commitMessage |
| git/dag | §8 | ✅ | detectEvent (ff/merge/rebase/revert/switch); revert re-validates prior fact |
| capture/episode-log + normalizers | §9 | ✅ | append-only JSONL + DB mirror; claude normalizer |
| extract/deterministic/* (10) | §10.1 | ✅ | package-scripts/metadata, editorconfig, tsconfig, tooling-config, lockfile, docker, test-config, ci, generated-markers, agent-files |
| extract/llm/* | §10.2 | ✅ | fact-extractor + procedure-miner (zod, secret-scrub, trust-cap, evidence-filter); 3 versioned prompts |
| invalidate/relation + invalidator | §11 | ✅ | deterministic-first + edges + cited-evidence post-check |
| invalidate/llm-agent | §11 | ✅ | provider-backed agent + null fallback; cited-evidence enforced by invalidator |
| invalidate/staleness | §11 | ✅ | I4 synchronous verify (< 5ms) |
| promote/gates + probation | §12 | ✅ | hard gates (D6); probation w/ verify; SessionEnd sweep |
| retrieve/retriever | §13 | ✅ | vector ∪ BM25 + entity + scope; commit-anchored filter |
| retrieve/vectors | §13 | ✅ | sqlite-vec hybrid; offline local embedder; BM25 fallback (I9) |
| retrieve/signals + rank | §13 | ✅ | scope/entity scorers; fusion w/ confidence + recency (S5) |
| resolve/precedence + conflicts | §14 | ✅ | full precedence (prose < user profile, D14); resolveConflicts + reconcileWrite optimistic concurrency (never silent LWW) |
| inject/gate | §15 | ✅ | centroid drift + entity-change + event-class; selective PreToolUse |
| inject/ledger | §15 | ✅ | DB-backed cross-process/cross-channel anti-repetition |
| inject/budget | §15 | ✅ | utility ranking + redundancy penalty + must-include bonuses + caps |
| inject/planner | §15 | ✅ | gate → retrieve → verify → dedupe → budget → render → log |
| render/capsule + cards + tokens | §16 | ✅ | fixed section order; open-loops + conflict sections; [mem:id] (I7) |
| adapters/adapter + registry + channel | §17 | ✅ | capability detection + tier routing; channel ladder T0-4; auto-detect client |
| adapters/claude-code | §17 | ✅ | install/hooks/templates; all lifecycle events wired (Tier 2) |
| adapters/cursor, opencode, generic, proxy | §17 | ✅ | cursor (rules+MCP, reversible uninstall, fail-closed malformed config, T0-1), opencode (MCP, fail-closed malformed config, T0-1-3), generic (T0-1 floor), proxy (T4 opt-in + secret-refusing) |
| mcp/server + tools | §18 | ✅ | stdio JSON-RPC (no SDK dep); MCP 2025-11-25 handshake; EXACTLY 8 tools (I8); input/output schemas; structuredContent; bounded Tier-1 rider |
| llm/provider + openai/anthropic/local | §10 | ✅ | lazy + async-only + fail-soft; bounded/cancellable fetch-based calls (no SDK deps); null provider = deterministic-only |
| security/secrets | §20 | ✅ | explicit-memory refusal + extraction/send-edge scans (I3); sensitivity stamping |
| security/trust | §20 | ✅ | trust tiers enforced via extractors + gates + precedence; LLM facts capped to low |
| security/sanitize | §20 | ✅ | prose kept low-trust + non-executable; proxy refuses secret capsules at the send edge |
| telemetry/metrics + outcomes | §21 | ✅ | local-only outcome classification + summary + learned ranking from injection outcomes |
| provenance/why | §11 | ✅ | full evidence chain reader + CLI; provenance gate covers complete/incomplete chains and rendered surfaces |
| eval/harness + suites | §22 | ✅ | compaction-recovery (A/B/C/N/S), core-memory-lifecycle, promotion-precision, drift-gate, retrieval-quality, gate-precision, security-adversarial, branch-truth, temporal-correctness, parallel-conflict, procedure-memory, adapters-mcp, storage-migrations, telemetry-learning, provenance-why, resilience-failsoft, eval-benchmarks, cli-docs-demo, code-quality; `eval all` runs all 19 suites |
| cli.ts | §19 | ✅ | init/install(claude\|cursor\|opencode\|generic\|auto)/uninstall/hook/recall/remember/loop/resolve/extract/serve --mcp/why/doctor/demo/tui/compare/bench/eval |

## Invariants (enforced throughout)

| ID | Invariant | Status |
|---|---|---|
| I1 | new facts default candidate | ✅ |
| I2 | repo prose low-trust, never auto-promoted/executable | ✅ |
| I3 | secrets never promoted/injected | ✅ (write + send-edge scan) |
| I4 | perishable facts verified before inject | ✅ |
| I5 | durable writes append-only | ✅ |
| I6 | respect token budgets, utility/token select | ✅ |
| I7 | every card carries provenance | ✅ |
| I8 | MCP surface ≤ 8 tools | ✅ (exactly 8; runtime + table guard) |
| I9 | failures degrade to no-memory | ✅ (every path wrapped) |

## Performance

| Metric | Budget | Latest |
|---|---|---|
| `hook <event>` p95 | < 150ms | 15.51ms ✅ |

_Last updated: Private-key scanning now covers DSA, encrypted PEM, and PGP private key block headers, MCP `resolve_conflict` now evaluates user, workspace, and current-session facts together, `graphctx resolve` now refuses non-open-loop facts instead of silently superseding durable memory, Storage migration 0006 adds a composite invalidation conflict lookup index, Session-scoped invalidation now keeps identical open loops isolated across sessions while deduping repeats within a session, Demo seed memory now uses Runtime.rememberFact, open-loop session memory now carries current git anchors, CLI `tui --tab` now fails fast on invalid tabs, CLI/MCP fact-kind validation uses a shared `FACT_KINDS` domain enum, TUI promotion uses Runtime/Probation gates instead of direct activation, Runtime/TUI/CLI/MCP explicit remember paths share safe git-anchored invalidating writes, Runtime/TUI/MCP forget paths share git-anchored temporal closeout, MCP forget stamps git closeout anchors, retrieval candidates are scope-filtered before semantic reranking, retrieval candidates receive final workspace/session scope filtering, superseded facts close temporal validity with `t_expired` and commit anchors, retrieval recency ranking uses the runtime clock, ranking/conflict tests use deterministic fact IDs and clocks, vector embedding cache uses the runtime clock, outcome telemetry uses an injectable clock, injection anti-repetition ledger uses the runtime clock, promotion verification timestamps use the runtime clock, promotion gates rescan secret-shaped fact identity, why renders invalidating commit closeout anchors, revert revalidation respects branch representation, revert revalidation skips bad historical anchors, atomic temporal lifecycle closeout anchors, TUI read model redacts secret fact text, conflict notes redact identity/object secrets, structured why redacts evidence chain metadata, structured why redacts fact identity and scope strings, structured why redacts promotion audit text, structured why redacts git anchors, structured why redacts evidence payloads and tags, why output shows expired/invalidated temporal closeout, send-edge safety scans fact tags for secrets, command cards avoid false HEAD verification claims, low-trust claims blocked from PreToolUse guardrail injection, candidate facts kept out of vector search until promotion, lifecycle-synced vector index entries for expired/reactivated facts, secret-redacted semantic rerank text, retriever-level send-unsafe fact suppression, tag-update secret sensitivity restamping, secret-redacted FTS/vector fact indexing, runtime-level injection context redaction, hook tool-result redaction before injection context, shared retrieval-context redaction for CLI/MCP/hooks, atomic invalidation effects, supported-by temporal evidence edges, tool-arg redaction before retrieval, hook prompt redaction before retrieval, transcript-tail redaction before retrieval, symlink-safe workspace config reads, symlink-safe local store paths, symlink-safe AGENTS.md boot capsule writes, symlink-safe generic adapter marker writes, symlink-safe OpenCode config writes, symlink-safe Cursor mcp writes, symlink-safe Claude settings writes, workspace-confined CI workflow extraction, workspace-confined agent prose extraction, workspace-confined Docker/Compose extraction, workspace-confined test config extraction, workspace-confined tooling config extraction, workspace-confined tsconfig extraction, workspace-confined editorconfig extraction, workspace-confined runtime version extraction, workspace-confined lockfile extraction, workspace-confined package script evidence, shared realpath workspace evidence checks, symlink-aware injection staleness checks, generated-marker symlink skip, procedure verifier secret scanning, extraction subject secret scanning, hook session-id redaction, MCP session-reference secret refusal, open-loop session metadata secret refusal, explicit memory metadata secret refusal, packageManager canonical facts, package-manager-aware script extraction, runtime-version deterministic extraction, multi-cookie session redaction, MCP error redaction, fail-closed retrieval for unvalidated commit-scoped facts, semantic CLI recall ranking, auth/cookie header secret scanning, scoped semantic retrieval expansion, workspace-confined injection staleness checks, package metadata extraction, high-trust test/Docker/tooling/tsconfig deterministic extraction, high-trust Python toolchain extraction, high-entropy redaction hardening, repo-id-isolated temporal validity, measured hook latency, fail-closed adapter install/uninstall, typed CLI error formatting, answer-bearing coding query expansion, Python package-manager retrieval expansion, redacted TUI selected-fact detail panels, and TUI page/jump keyboard navigation. 275 tests, 19 gate suites green, all I1-I9 hold._

_Quality counters: Tests: 275. Gate suites: 19._

_Runtime-clock note: direct CLI, eval, and benchmark retrievers pass
`Runtime.clock`, so pull and push retrieval use the same recency clock seam._

_Safety note: AWS temporary STS access key IDs (`ASIA...`) are classified and
redacted with the same send-edge protections as long-lived `AKIA...` keys._

_Safety note: Google API keys (`AIza...`) and Azure SAS signatures (`sig=...`)
now have explicit scanners instead of relying only on entropy fallback._

---

## Perfection Mission — Aspect Ledger

> Ongoing autonomous engineering/research loop driving every aspect to a measured
> "perfected" bar. Source of truth: `memory` knowledge graph + this table. Always-green
> bar (tsc + biome + vitest + `eval all` + bench p95<150ms) holds at every commit.

| Aspect | Status | Latest measurement / note |
|---|---|---|
| Green tree (5 gates) | ✅ perfected | all 5 gates green; biome format errors fixed (iter1) |
| Retrieval & ranking | ✅ | hybrid RRF + deterministic semantic features + bounded MMR diversity: recall@1/5/10 1.00, MRR 1.00, semantic no-overlap rank 1, SessionStart broad-push includes explicit user preferences, retriever suppresses send-unsafe facts before returning results, scope filtering prevents same-session cross-workspace leaks before semantic reranking or output, semantic rerank text is redacted before embedding, and fact tag updates keep FTS/vector indexes searchable. `eval retrieval` regression gate |
| Relevance gate precision | ✅ | utility-grounded gate suite: P/R/F1=1.0 on 28 labeled cases, near-threshold drift discrimination, selective PreToolUse with harmless shell negatives, failure-only PostToolUse, 0 harmful injections, 0 dupes. Guarded in `eval gate` + `eval drift` |
| Invalidation & temporal | ✅ | real-git temporal-correctness suite: 11/11 gated scenarios over throwaway repos. Deterministic extraction now expires facts when structured evidence disappears while preserving why() history; identical facts merge evidence through `SUPPORTED_BY` graph edges and retire duplicate active facts with `t_expired`; supersession and open-loop resolution close commit validity windows, including reactivation when a superseding commit is reverted; invalidation relation effects are transaction-wrapped so partial fact/edge writes roll back; repo-id isolation blocks foreign-repo anchors from injection, full git-anchor restamping updates file/symbol/hunk/patch metadata, patch-id equivalence keeps cherry-picked branch facts valid, and same-branch rebase false positives remain blocked. `eval temporal` guards it |
| Conflict & precedence | ✅ | comprehensive eval: 62-case ladder/determinism/resolve/reconcile/invalidation-precedence gate remains 62/62 with silentWrongWinners=0; planner resolves precedence before budget redundancy so lower-precedence duplicate keys cannot hide structured evidence; conflict summaries render low-trust losers as claims; real Runtime concurrent-writer stress over a shared store reports 3/3 races and `silentOverwrites: 0`. `eval conflict` guards it |
| LLM extraction & procedures | ✅ | default Anthropic model updated to `claude-haiku-4-5`; provider calls are bounded/cancellable and fail-soft; hermetic `eval procedure` passes 7/7 with 0 leaks/high-trust/hallucinated evidence, including secret-bearing verifier rejection, and opt-in live gate reports 1 schema-valid fact with precision/recall 1.0/1.0 |
| Promotion engine | ✅ | `eval promote` now gates hard boolean admission with atomic audited probation: precision/recall 100%/100%, 0 secret/task_state leaks, verified-procedure succeeds through the procedures table, missing-target perishable facts are held (`held unverified: 1`), and fact state rolls back if promotion audit recording fails |
| Adapters & channel ladder | ✅ | `eval mcp` covers marked client detection, highest-tier selection, Tier 0/1/2 transport-only capsule invariance, reversible cursor install/uninstall preserving unrelated MCP config, fail-closed malformed config handling across Claude/Cursor/OpenCode install and uninstall, parseable opencode installs, secure opt-in proxy, and Claude hook Tier-2/fail-soft behavior |
| MCP server & 8-tool surface | ✅ | `eval mcp` now covers 88/88 adapter/MCP checks: MCP 2025-11-25 initialize shape, exact 8-tool live/static surface with count-drift hard error, per-tool zod input + output-shape contracts including lifecycle-event enum and scalar JSON schema constraints, JSON-RPC -32602/-32601 errors, redacted tool/validation errors, bounded anti-repetition rider, last-8 provenance lookup, MCP `remember` git-anchor stamping and `forget` git-closeout stamping, `resolve_conflict` workspace/current-session conflict coverage, text/metadata secret refusal, MCP recall/inject prompt redaction before retrieval context, MCP session-reference secret refusal before retrieval/planning/logging, telemetry precedence, real `serve --mcp` stdio initialize/tools-list, Claude adapter detection, static-floor secret refusal, and config-preserving/symlink-safe fail-closed adapter install/uninstall paths |
| Security (injection/secrets/trust) | ✅ | adversarial benchmark: secret recall 1.0/precision 1.0 including credential-bearing database URLs, webhook URLs, and PEM/PGP private key headers; deterministic extraction skips symlinked directories and scans subjects before storage; LLM extraction scans subjects before storage; explicit CLI/MCP memory writes and open-loop session metadata refuse secrets before storage; FTS/vector secondary indexes redact secret-bearing fact text before indexing, and tag metadata updates restamp sensitivity to secret; high-entropy redaction covers regex-metacharacter tokens; 0 poison promoted across expanded attack families; 0 harmful capsule cards; deterministic fuzz cases. `eval security` plus `eval memory`/`eval mcp` guard it |
| Performance (latency/scale) | ✅ | bounded long-prompt FTS term cap plus streaming bulk scale bench: 1k/10k/50k PASS with measured p95 1.59/1.73/1.76ms after this change, default 100k PASS, 1M p95 ~1.4ms, finite ingest timing, `bench --footprint` startup/RSS/heap gate, and impossible-budget FAIL path |
| Storage & migrations | ✅ | new `eval storage` passes 14/14: schema_version 6, reopen migrations 0, failed migrations roll back partial DDL and schema_version, v1→v6 rows preserved 3/3 with t_observed backfill plus hot-path fact scope and invalidation conflict indexes, append-only expire tombstones retained, malformed rows skipped, missing optional ledger table degrades, WAL/FK/busy_timeout enforced, cascades/edge trail consistent |
| Telemetry & outcome learning | ✅ | new `eval telemetry` passes 9/9: classifier accuracy 1.00>=0.90 with harmful-over-helped precedence, local-only recording with 0 network calls and disabled-write=0, signal storage whitelists known booleans and drops secret/unknown fields, fail-soft missing-table handling, malformed summary rows skipped, learned ranking lift +1.00, and DB-backed ledger cross-channel/open_loop behavior |
| Provenance / why() | ✅ | new `eval provenance` passes 5/5: deterministic extract→why chain complete, last-8 suffix equals full-id report, unknown id exits cleanly with `no fact found`, clean vs dangling evidence reports complete/incomplete, and git anchor/promotions/edges sections render when present |
| Resilience & fail-soft (I9) | ✅ | new `eval resilience` passes 16/16: no-key deterministic-only capsule emits with exit 0, corrupt DB, symlinked local stores, symlinked workspace config, and bad config degrade to empty output, missing git and planner crashes never propagate, secret-bearing hook payloads, hook session ids, prompts, transcript tails, tool args, and tool results are redacted before persistence, retrieval, or injection context, provider resolution returns `nullProvider`, no-key extraction is a deterministic no-op, and SessionStart/SessionEnd lifecycle hooks run fail-soft |
| Eval harness & benchmarks | ✅ | `eval benchmarks` passes 7/7: centralized 19-suite registry, A/B/C/N/S ablation confirms push 93% > pull 21% with N/S 5/5 controls, offline graphCTX-vs-Supermemory scorecard renders, live bake-off skips without key, deep local coding-memory recall is 10/10 with p95 under budget, 1k/10k scale p95 stays under budget, empty/invalid scale size lists fail closed instead of passing vacuously, and trapped offline network calls remain 0 |
| CLI / UX / docs / demo | ✅ | `eval cli-docs-demo` passes 11/11 and `eval memory` passes 16/16: help/docs command surface aligned, SPEC §15/§17 hook event drift fixed, demo facts stay memory-only/offline, doctor prints READY/NOT READY remediation, MCP advertises exactly 8 tools, Claude install round-trip and piped auto-detect hold, invalid numeric flags, invalid fact kinds, and invalid TUI tabs fail before work starts, and typed CLI errors are action-oriented and stack-free |
| Code quality | ✅ | new `eval quality` passes 6/6: full-repo Biome, strict TS config/scripts, shared command-surface helpers for CLI help/docs/README reachability, eval-suite runner/test coverage, final README docs-as-code, and generated migration packaging guard |

_Loop note: composite metric = (failing_gates × 100) + (un-perfected aspects); within-aspect
measured gains are recorded in the `memory` graph. Tests: 275, gate suites: 19 (`eval all` includes run/memory/promote/drift/retrieval/gate/security/branch/temporal/conflict/procedure/mcp/storage/telemetry/provenance/resilience/benchmarks/cli-docs-demo/quality)._

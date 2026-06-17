# graphCTX — Implementation Status

> Living checklist mapping every SPEC module to its build status. Updated at each
> phase boundary. Legend: ✅ done · 🟡 partial · ⬜ missing.

| Phase | Branch | Gate | Status |
|---|---|---|---|
| M0 — thesis spike | `m0-spike` | push beats pull | ✅ PASS (C 100% vs B 21%) |
| M1 — memory core | `m1-finish` | promotion precision ≥ 90% | ✅ PASS (100% precision/recall, 0 leaks) |
| M2 — injection loop | `m2-injection` | harmful-injection < target + selective gate | ✅ PASS (0 harmful, 31% PreToolUse fire-rate, 0 dupes) |
| M3 — robustness | `m3-robustness` | branch-truth + parallel-conflict + procedure pass | ✅ PASS (0 leaks, 0 silent winners, safe LLM extraction) |
| M4 — adapters + MCP | `adapters-mcp` | install per client + MCP contract + secure proxy | ✅ PASS (54/54; MCP=8 tools; 0 proxy leaks) |

## Module status (SPEC §2 layout)

| Module | SPEC § | Status | Notes |
|---|---|---|---|
| core/ (types, ids, errors, clock) | §7 | ✅ | open_loop kind added; signals extended (confidence/recency) |
| config/ (schema, defaults, load) | §5 | ✅ | zod-validated; PostToolUse enabled |
| store/db + migrations | §6 | ✅ | 0001 init, 0002 M1 (embedding_cache/promotions), 0003 M2 (inject_ledger); storage gate covers forward migrations, pragmas, corruption recovery |
| store/facts.repo | §6.2 | ✅ | append-only (I5); sensitivity auto-stamp; openLoops() |
| store/episodes.repo | §9 | ✅ | append + tail (drift window) |
| store/edges.repo | §6 | ✅ | SUPERSEDES/INVALIDATES/CONFLICTS_WITH/OVERRIDES/SUPERSEDED_BY |
| store/promotions.repo | §12 | ✅ | audit trail (powers why()) |
| store/injections.repo | §21 | ✅ | logs selected/rejected/tokens; outcome_json feeds local learned ranking |
| store/entities.repo | §6 | ⬜ | deferred — entity scoring already in retriever; M1 recall 100%, no measured benefit (honest skip) |
| store/procedures.repo | §6 | ✅ | full CRUD; descriptive-only (D10); success/failure tracking |
| git/git + anchors | §8 | ✅ | head/branch/isAncestor/validity; anchorAtHead; branch filter; parentsOf/commitMessage |
| git/dag | §8 | ✅ | detectEvent (ff/merge/rebase/revert/switch); revert re-validates prior fact |
| capture/episode-log + normalizers | §9 | ✅ | append-only JSONL + DB mirror; claude normalizer |
| extract/deterministic/* (6) | §10.1 | ✅ | package-scripts, editorconfig, lockfile, ci, generated-markers, agent-files |
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
| adapters/cursor, opencode, generic, proxy | §17 | ✅ | cursor (rules+MCP, T0-1), opencode (MCP, T0-1-3), generic (T0-1 floor), proxy (T4 opt-in + secret-refusing) |
| mcp/server + tools | §18 | ✅ | stdio JSON-RPC (no SDK dep); MCP 2025-11-25 handshake; EXACTLY 8 tools (I8); input/output schemas; structuredContent; bounded Tier-1 rider |
| llm/provider + openai/anthropic/local | §10 | ✅ | lazy + async-only + fail-soft; fetch-based (no SDK deps); null provider = deterministic-only |
| security/secrets | §20 | ✅ | scan on write + capsule pre-send (I3); sensitivity stamping |
| security/trust | §20 | ✅ | trust tiers enforced via extractors + gates + precedence; LLM facts capped to low |
| security/sanitize | §20 | ✅ | prose kept low-trust + non-executable; proxy refuses secret capsules at the send edge |
| telemetry/metrics + outcomes | §21 | ✅ | local-only outcome classification + summary + learned ranking from injection outcomes |
| provenance/why | §11 | ✅ | full evidence chain reader + CLI; provenance gate covers complete/incomplete chains and rendered surfaces |
| eval/harness + suites | §22 | ✅ | compaction-recovery (A/B/C/N/S), promotion-precision, drift-gate, branch-truth, parallel-conflict, procedure-memory, adapters-mcp, storage-migrations, telemetry-learning, provenance-why, resilience-failsoft; `eval all` runs resilience |
| cli.ts | §19 | ✅ | init/install(claude\|cursor\|opencode\|generic\|auto)/uninstall/hook/serve --mcp/recall/remember/extract/why/loop/resolve/doctor/demo/bench/eval; profile/time-travel are nice-to-have, deferred |

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
| `hook <event>` p95 | < 150ms | ~8.8ms ✅ |

_Last updated: resilience-failsoft parity. 167 tests, 16 gate suites green, all I1-I9 hold._

---

## Perfection Mission — Aspect Ledger

> Ongoing autonomous engineering/research loop driving every aspect to a measured
> "perfected" bar. Source of truth: `memory` knowledge graph + this table. Always-green
> bar (tsc + biome + vitest + `eval all` + bench p95<150ms) holds at every commit.

| Aspect | Status | Latest measurement / note |
|---|---|---|
| Green tree (5 gates) | ✅ perfected | all 5 gates green; biome format errors fixed (iter1) |
| Retrieval & ranking | 🟡 in-progress | RRF fusion (iter3) + stopword filter (iter8): recall@1 0.61, recall@5 0.94, recall@10 1.00, MRR 0.76 (was 0.33/0.50/0.67/0.43). `eval retrieval` regression gate |
| Relevance gate precision | 🟡 in-progress | gate-precision suite (iter4): P/R/F1=1.0 on 26 labeled cases, all 4 branches (TP15 FP0 FN0 TN11). Guarded in `eval gate`. To perfect: adversarial + utility-labeled dataset |
| Invalidation & temporal | ✅ | real-git temporal-correctness suite: 8/8 gated scenarios over throwaway repos. Patch-id equivalence is now wired into `isValidAsOf`, so a branch fact anchored to X is valid on another branch after cherry-pick Y; same-branch rebase false positives remain blocked. `eval temporal` guards it |
| Conflict & precedence | ✅ | comprehensive eval: original 60-case ladder/determinism/resolve/reconcile gate remains 60/60 with silentWrongWinners=0, plus real Runtime concurrent-writer stress over a shared store reports 3/3 races and `silentOverwrites: 0`. `eval conflict` guards it |
| LLM extraction & procedures | ✅ | default Anthropic model updated to `claude-haiku-4-5`; hermetic `eval procedure` passes 6/6 with 0 leaks/high-trust/hallucinated evidence, and opt-in live gate reports 1 schema-valid fact with precision/recall 1.0/1.0 |
| Promotion engine | ✅ | `eval promote` now gates hard boolean admission with real probation: precision/recall 100%/100%, 0 secret/task_state leaks, verified-procedure succeeds through the procedures table, and missing-target perishable facts are held (`held unverified: 1`) |
| Adapters & channel ladder | ✅ | `eval mcp` now covers 28/28 adapter/channel checks: marked client detection, highest-tier selection, Tier 0/1/2 transport-only capsule invariance, parseable cursor/opencode installs, secure opt-in proxy, and Claude hook Tier-2/fail-soft behavior |
| MCP server & 8-tool surface | ✅ | `eval mcp` now covers 55/55 checks: MCP 2025-11-25 initialize shape, exact 8-tool live/static surface with count-drift hard error, per-tool zod input + output-shape contracts, JSON-RPC -32602/-32601 errors, bounded anti-repetition rider, telemetry precedence, and real `serve --mcp` stdio initialize/tools-list |
| Security (injection/secrets/trust) | 🟡 in-progress | adversarial benchmark (iter5-6): secret recall 1.0/precision 1.0; 0/13 poison promoted; 0 harmful capsule cards. `eval security` guards it. To perfect: more attack classes, fuzzing |
| Performance (latency/scale) | ✅ | streaming bulk scale bench: default 1k/10k/50k/100k PASS, 1M p95 ~1.4ms, finite ingest timing, `bench --footprint` startup/RSS/heap gate, and impossible-budget FAIL path |
| Storage & migrations | ✅ | new `eval storage` passes 10/10: schema_version 3, reopen migrations 0, v1→v3 rows preserved 3/3, append-only expire tombstones retained, malformed rows skipped, missing optional ledger table degrades, WAL/FK/busy_timeout enforced, cascades/edge trail consistent |
| Telemetry & outcome learning | ✅ | new `eval telemetry` passes 8/8: classifier accuracy 1.00>=0.90 with harmful-over-helped precedence, local-only recording with 0 network calls and disabled-write=0, fail-soft missing-table handling, malformed summary rows skipped, learned ranking lift +1.00, and DB-backed ledger cross-channel/open_loop behavior |
| Provenance / why() | ✅ | new `eval provenance` passes 5/5: deterministic extract→why chain complete, last-8 suffix equals full-id report, unknown id exits cleanly with `no fact found`, clean vs dangling evidence reports complete/incomplete, and git anchor/promotions/edges sections render when present |
| Resilience & fail-soft (I9) | ✅ | new `eval resilience` passes 9/9: no-key deterministic-only capsule emits with exit 0, corrupt DB and bad config degrade to empty output, missing git and planner crashes never propagate, provider resolution returns `nullProvider`, no-key extraction is a deterministic no-op, and SessionStart/SessionEnd lifecycle hooks run fail-soft |
| Eval harness & benchmarks | ⬜ untouched | 8 suites green; competitor head-to-head pending |
| CLI / UX / docs / demo | ⬜ untouched | docs drift fixed (test count); demo repro pending |
| Code quality | ⬜ untouched | coverage % + dead-code audit pending |

_Loop note: composite metric = (failing_gates × 100) + (un-perfected aspects); within-aspect
measured gains are recorded in the `memory` graph. Tests: 167, gate suites: 16 (`eval all` includes retrieval/gate/security/temporal/conflict/procedure/promotion/mcp/storage/telemetry/provenance/resilience)._

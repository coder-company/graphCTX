# graphCTX — Implementation Status

> Living checklist mapping every SPEC module to its build status. Updated at each
> phase boundary. Legend: ✅ done · 🟡 partial · ⬜ missing.

| Phase | Branch | Gate | Status |
|---|---|---|---|
| M0 — thesis spike | `m0-spike` | push beats pull | ✅ PASS (C 100% vs B 21%) |
| M1 — memory core | `m1-finish` | promotion precision ≥ 90% | ✅ PASS (100% precision/recall, 0 leaks) |
| M2 — injection loop | `m2-injection` | harmful-injection < target + selective gate | ✅ PASS (0 harmful, 31% PreToolUse fire-rate, 0 dupes) |
| M3 — robustness | `m3-robustness` | branch-truth + parallel-conflict + procedure pass | ✅ PASS (0 leaks, 0 silent winners, safe LLM extraction) |
| M4 — adapters + MCP | `adapters-mcp` | install per client + MCP smoke + secure proxy | ✅ PASS (20/20; MCP=8 tools; 0 proxy leaks) |

## Module status (SPEC §2 layout)

| Module | SPEC § | Status | Notes |
|---|---|---|---|
| core/ (types, ids, errors, clock) | §7 | ✅ | open_loop kind added; signals extended (confidence/recency) |
| config/ (schema, defaults, load) | §5 | ✅ | zod-validated; PostToolUse enabled |
| store/db + migrations | §6 | ✅ | 0001 init, 0002 M1 (embedding_cache/promotions), 0003 M2 (inject_ledger) |
| store/facts.repo | §6.2 | ✅ | append-only (I5); sensitivity auto-stamp; openLoops() |
| store/episodes.repo | §9 | ✅ | append + tail (drift window) |
| store/edges.repo | §6 | ✅ | SUPERSEDES/INVALIDATES/CONFLICTS_WITH/OVERRIDES/SUPERSEDED_BY |
| store/promotions.repo | §12 | ✅ | audit trail (powers why()) |
| store/injections.repo | §21 | ✅ | logs selected/rejected/tokens; outcome_json column ready |
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
| mcp/server + tools | §18 | ✅ | stdio JSON-RPC (no SDK dep); EXACTLY 8 tools (I8); Tier-1 parasitic rider |
| llm/provider + openai/anthropic/local | §10 | ✅ | lazy + async-only + fail-soft; fetch-based (no SDK deps); null provider = deterministic-only |
| security/secrets | §20 | ✅ | scan on write + capsule pre-send (I3); sensitivity stamping |
| security/trust | §20 | ✅ | trust tiers enforced via extractors + gates + precedence; LLM facts capped to low |
| security/sanitize | §20 | ✅ | prose kept low-trust + non-executable; proxy refuses secret capsules at the send edge |
| telemetry/metrics + outcomes | §21 | ✅ | local-only outcome classification (helped/ignored/harmful) → injection rows |
| provenance/why | §11 | ✅ | full evidence chain reader + CLI |
| eval/harness + suites | §22 | ✅ | compaction-recovery (A/B/C/N/S), promotion-precision, drift-gate, branch-truth, parallel-conflict, procedure-memory, adapters-mcp; `eval all` runs all 7 |
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

_Last updated: end of Phase 4 (M4). 121 tests, 7 gate suites green, all I1-I9 hold._

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
| Invalidation & temporal | 🟡 in-progress | real-git temporal-correctness suite (iter9): 7/7 gated scenarios over throwaway repos (fast-forward/branch-isolation/revert/merge/rebase/cherry-pick patch-id/detectEvent matrix). Fixed SEVERE `isAncestor` always-true bug + revert-trailer revalidation + patch-id `--no-commit-id`. `eval temporal` guards it. To perfect: wire patch-id equivalence into `isValidAsOf` (known gap) |
| Conflict & precedence | 🟡 in-progress | comprehensive eval (iter10): 60 gated cases — 36-pair precedence ladder cross-product (incl D14 prose<profile), stable total-order determinism, resolveConflicts semantics, reconcile matrix w/ adversarial edges. silentWrongWinners=0. `eval conflict` guards it. To perfect: real concurrent-session stress + load |
| LLM extraction & procedures | ⬜ untouched | safe+capped; precision/recall not quantified |
| Promotion engine | ⬜ untouched | precision 100% on labeled set; recall on larger set pending |
| Adapters & channel ladder | ⬜ untouched | 20/20 smoke; real-client integration pending |
| MCP server & 8-tool surface | ⬜ untouched | exactly 8 tools; latest-spec compliance pending |
| Security (injection/secrets/trust) | 🟡 in-progress | adversarial benchmark (iter5-6): secret recall 1.0/precision 1.0; 0/13 poison promoted; 0 harmful capsule cards. `eval security` guards it. To perfect: more attack classes, fuzzing |
| Performance (latency/scale) | ✅ | streaming bulk scale bench: default 1k/10k/50k/100k PASS, 1M p95 ~1.4ms, finite ingest timing, `bench --footprint` startup/RSS/heap gate, and impossible-budget FAIL path |
| Storage & migrations | ⬜ untouched | append-only; corruption-recovery breadth pending |
| Telemetry & outcome learning | ⬜ untouched | classification accuracy + learned scoring pending |
| Provenance / why() | ⬜ untouched | completeness audit across fact kinds pending |
| Resilience & fail-soft (I9) | ⬜ untouched | 5 tests pass; fault-injection breadth pending |
| Eval harness & benchmarks | ⬜ untouched | 8 suites green; competitor head-to-head pending |
| CLI / UX / docs / demo | ⬜ untouched | docs drift fixed (test count); demo repro pending |
| Code quality | ⬜ untouched | coverage % + dead-code audit pending |

_Loop note: composite metric = (failing_gates × 100) + (un-perfected aspects); within-aspect
measured gains are recorded in the `memory` graph. Tests: 153, gate suites: 11 (`eval all` includes retrieval/gate/security/temporal/conflict)._

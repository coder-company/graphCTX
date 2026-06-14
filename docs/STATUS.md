# graphCTX — Implementation Status

> Living checklist mapping every SPEC module to its build status. Updated at each
> phase boundary. Legend: ✅ done · 🟡 partial · ⬜ missing.

| Phase | Branch | Gate | Status |
|---|---|---|---|
| M0 — thesis spike | `m0-spike` | push beats pull | ✅ PASS (C 100% vs B 21%) |
| M1 — memory core | `m1-finish` | promotion precision ≥ 90% | ✅ PASS (100% precision/recall, 0 leaks) |
| M2 — injection loop | `m2-injection` | harmful-injection < target + selective gate | ✅ PASS (0 harmful, 31% PreToolUse fire-rate, 0 dupes) |
| M3 — robustness | `m3-robustness` | branch-truth + parallel-conflict + procedure pass | ✅ PASS (0 leaks, 0 silent winners, safe LLM extraction) |
| M4 — adapters + MCP | `adapters-mcp` | install per client + MCP smoke | ⬜ not started |

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
| adapters/adapter | §17 | 🟡 | interface + tiers defined; capability detection in M4 |
| adapters/claude-code | §17 | ✅ | install/hooks/templates; all lifecycle events wired |
| adapters/cursor, opencode, generic, proxy | §17 | ⬜ | M4 |
| mcp/server + tools | §18 | ⬜ | M4 (exactly 8 tools, I8) |
| llm/provider + openai/anthropic/local | §10 | ✅ | lazy + async-only + fail-soft; fetch-based (no SDK deps); null provider = deterministic-only |
| security/secrets | §20 | ✅ | scan on write + capsule pre-send (I3); sensitivity stamping |
| security/trust | §20 | ✅ | trust tiers enforced via extractors + gates + precedence; LLM facts capped to low |
| security/sanitize | §20 | 🟡 | prose kept low-trust + non-executable; explicit neutralization framing in M4 |
| telemetry/metrics + outcomes | §21 | ⬜ | M4 (local-only outcome classification) |
| provenance/why | §11 | ✅ | full evidence chain reader + CLI |
| eval/harness + suites | §22 | ✅ | compaction-recovery (A/B/C/N/S), promotion-precision, drift-gate, branch-truth, parallel-conflict, procedure-memory; `eval all` |
| cli.ts | §19 | 🟡 | init/install/hook/serve/recall/remember/extract/why/loop/resolve/doctor/demo/bench/eval; profile/conflicts/time-travel pending |

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
| I8 | MCP surface ≤ 8 tools | ⬜ (MCP server in M4) |
| I9 | failures degrade to no-memory | ✅ (every path wrapped) |

## Performance

| Metric | Budget | Latest |
|---|---|---|
| `hook <event>` p95 | < 150ms | ~8.7ms ✅ |

_Last updated: end of Phase 3 (M3). 120 tests, 6 gate suites green._

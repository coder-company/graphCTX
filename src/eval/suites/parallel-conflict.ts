import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fact, ScoredFact } from "../../core/types.js";
import {
  type ConcurrencyOutcome,
  reconcileWrite,
  resolveConflicts,
} from "../../resolve/conflicts.js";
import { byPrecedence, precedenceRank } from "../../resolve/precedence.js";
import { Runtime } from "../../runtime.js";

// Parallel-conflict (SPEC §14, M3 gate). graphCTX must NEVER silently pick a
// last-writer-wins winner. This suite is a COMPREHENSIVE, permanent regression
// gate over the FULL conflict & precedence input space, not a handful of cases:
//
//   1. Precedence ladder — the cross-product of all 9 ranks: every higher-
//      precedence rank must win against EVERY lower one in resolveConflicts.
//      (Includes design decision D14: repo PROSE ranks BELOW user profile.)
//   2. Determinism — byPrecedence is a STABLE TOTAL order; equal-rank ties break
//      by contentKey, identically across shuffled inputs.
//   3. resolveConflicts semantics — pass-through, same-value collapse (no false
//      conflict), genuine contradiction surfaces EXACTLY one note (loser hidden,
//      never silently dropped or kept).
//   4. reconcileWrite matrix — apply / partition / invalidate / disputed across
//      stale-base, idempotency, branch-disjointness, high-trust-supersedes-prose
//      and the adversarial edges (high-vs-high, non-ancestor base, one-sided
//      branch, base_seen idempotency).
//   5. Real Runtime concurrent stress — two durable writers over the same store
//      race stale-base writes; outcomes preserve/audit both sides.
//   6. Headline metric — silentWrongWinners MUST be 0: an ambiguous contradiction
//      resolving to `apply` is a silent LWW = catastrophic.

export interface LadderResult {
  pairs: number; // ordered (higher, lower) rank pairs exercised
  passed: number; // pairs where the higher-precedence rank won AND conflict surfaced
}

export interface DeterminismResult {
  runs: number; // shuffles compared against the canonical ordering
  stable: boolean; // every shuffle produced an identical total order
  tiebreakByContentKey: boolean; // equal-rank facts ordered by contentKey, not input order
}

export interface SectionResult {
  cases: number;
  passed: number;
}

export interface ConcurrentStressResult {
  cases: number;
  passed: number;
  silentOverwrites: number;
  outcomes: Record<string, number>;
}

export interface ParallelConflictReport {
  cases: number; // total gated cases across all sections
  passed: number;
  silentWrongWinners: number; // genuine contradictions silently resolved to apply (want 0)
  ladder: LadderResult;
  determinism: DeterminismResult;
  resolve: SectionResult; // resolveConflicts semantics cases
  reconcile: SectionResult; // reconcileWrite matrix cases
  concurrent: ConcurrentStressResult; // real Runtime two-writer stress
  detail: string[];
  pass: boolean;
}

// ---- fact builder -----------------------------------------------------------

function fact(over: Partial<Fact>): Fact {
  return {
    fact_id: Math.random().toString(36).slice(2),
    subject: "repo",
    predicate: "package_manager",
    object: "npm",
    fact_kind: "constraint",
    temporal_kind: "static",
    scope: { user_id: "u", workspace_id: "w" },
    status: "active",
    promotion_state: "workspace_active",
    trust_tier: "low",
    sensitivity: "public",
    confidence: 0.6,
    evidence_count: 1,
    contradiction_count: 0,
    injection_count: 0,
    time: { t_created: "2026-01-01T00:00:00Z", t_recorded: "2026-01-01T00:00:00Z" },
    source: { asserted_by: "user", event_ids: [] },
    tags: [],
    ...over,
  };
}

// The current session id used to make a "current-session user instruction" (rank 1).
const CUR = "s-current";

// Minimal, canonical attribute set that lands a fact at EACH precedence rank
// (0 highest precedence … 8 lowest). Verified exhaustively below.
const RANK_LABELS = [
  "safety/permissions",
  "current-session user instruction",
  "repo structured evidence",
  "workspace decision",
  "user static profile",
  "user dynamic profile",
  "older session memory",
  "agent inference",
  "repo prose",
] as const;

function rankFact(rank: number, object: string, extra?: Partial<Fact>): Fact {
  const base: Record<number, Partial<Fact>> = {
    0: { tags: ["safety"] },
    1: {
      source: { asserted_by: "user", event_ids: [] },
      scope: { user_id: "u", workspace_id: "w", session_id: CUR },
    },
    2: {
      trust_tier: "high",
      source: { asserted_by: "deterministic_parser", event_ids: [] },
    },
    3: {
      promotion_state: "workspace_active",
      source: { asserted_by: "user", event_ids: [] },
    },
    4: {
      promotion_state: "user_static_active",
      source: { asserted_by: "user", event_ids: [] },
    },
    5: {
      promotion_state: "user_dynamic_active",
      source: { asserted_by: "user", event_ids: [] },
    },
    6: {
      promotion_state: "session_only",
      source: { asserted_by: "tool", event_ids: [] },
    },
    7: {
      promotion_state: "session_only",
      source: { asserted_by: "agent", event_ids: [] },
    },
    8: {
      trust_tier: "low",
      source: { asserted_by: "deterministic_parser", event_ids: [] },
    },
  };
  return fact({ object, ...base[rank], ...extra });
}

// ---- section 1: full precedence ladder cross-product ------------------------

function runLadder(detail: string[]): LadderResult {
  // First confirm every rank is exactly constructible (guards the matrix below).
  for (let r = 0; r <= 8; r++) {
    const got = precedenceRank(rankFact(r, `v${r}`), CUR);
    if (got !== r) {
      detail.push(`  ✗ ladder: rank builder for ${r} produced rank ${got} (${RANK_LABELS[r]})`);
    }
  }

  let pairs = 0;
  let passed = 0;
  // Cross-product of ALL ordered (higher, lower) precedence rank pairs — adjacent
  // and non-adjacent. higher rank index = lower precedence; hi < lo means hi wins.
  for (let hi = 0; hi <= 8; hi++) {
    for (let lo = hi + 1; lo <= 8; lo++) {
      pairs += 1;
      const winnerFact = rankFact(hi, `win-${hi}`);
      const loserFact = rankFact(lo, `lose-${lo}`);
      // Feed in loser-first order so a correct result cannot come from insertion order.
      const scored: ScoredFact[] = [
        { fact: loserFact, score: 1 },
        { fact: winnerFact, score: 1 },
      ];
      const res = resolveConflicts(scored, CUR);
      const winnerWon =
        res.resolved.length === 1 && res.resolved[0]!.fact.fact_id === winnerFact.fact_id;
      const loserSuppressed = !res.resolved.some((s) => s.fact.fact_id === loserFact.fact_id);
      const surfaced = res.conflicts.length === 1;
      const ok = winnerWon && loserSuppressed && surfaced;
      if (ok) passed += 1;
      else {
        detail.push(
          `  ✗ ladder ${hi}>${lo} (${RANK_LABELS[hi]} > ${RANK_LABELS[lo]}): ` +
            `winnerWon=${winnerWon} loserSuppressed=${loserSuppressed} surfaced=${surfaced}`,
        );
      }
    }
  }

  // Spotlight the easy-to-regress invariants (also covered by the cross-product).
  const spotlights: Array<{ label: string; hi: number; lo: number }> = [
    { label: "D14: repo PROSE (8) ranks BELOW user static profile (4)", hi: 4, lo: 8 },
    { label: "D14: repo PROSE (8) ranks BELOW user dynamic profile (5)", hi: 5, lo: 8 },
    { label: "safety/permissions (0) beats current-session user instruction (1)", hi: 0, lo: 1 },
    { label: "repo STRUCTURED evidence (2) beats user static profile (4)", hi: 2, lo: 4 },
  ];
  for (const s of spotlights) {
    const winnerFact = rankFact(s.hi, `win-${s.hi}`);
    const loserFact = rankFact(s.lo, `lose-${s.lo}`);
    const res = resolveConflicts(
      [
        { fact: loserFact, score: 1 },
        { fact: winnerFact, score: 1 },
      ],
      CUR,
    );
    const ok = res.resolved.length === 1 && res.resolved[0]!.fact.fact_id === winnerFact.fact_id;
    detail.push(`  ${ok ? "✓" : "✗"} ${s.label}`);
  }

  detail.push(`  → precedence ladder: ${passed}/${pairs} ordered rank pairs correct`);
  return { pairs, passed };
}

// ---- section 2: determinism / total ordering --------------------------------

function shuffle<T>(arr: T[], seed: number): T[] {
  // Deterministic LCG shuffle so the test itself is reproducible.
  const a = [...arr];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function keyOf(f: Fact): string {
  return `${precedenceRank(f, CUR)}|${f.subject}::${f.predicate}::${objStr(f)}`;
}

function objStr(f: Fact): string {
  return typeof f.object === "string" ? f.object : JSON.stringify(f.object);
}

function runDeterminism(detail: string[]): DeterminismResult {
  // One fact per rank with a DISTINCT object → distinct contentKeys.
  const facts = Array.from({ length: 9 }, (_, r) => rankFact(r, `obj-${r}`));
  const canonical = byPrecedence(facts, CUR).map(keyOf);
  const runs = 12;
  let stable = true;
  for (let i = 0; i < runs; i++) {
    const ordering = byPrecedence(shuffle(facts, i + 1), CUR).map(keyOf);
    if (ordering.join("|") !== canonical.join("|")) {
      stable = false;
      detail.push(`  ✗ determinism: shuffle seed ${i + 1} produced a different total order`);
    }
  }
  detail.push(`  ${stable ? "✓" : "✗"} byPrecedence stable total order across ${runs} shuffles`);

  // Equal-rank tiebreak: several facts at the SAME rank with distinct objects must
  // order by contentKey, regardless of insertion order.
  const sameRank = ["zebra", "apple", "mango", "delta"].map((o) => rankFact(6, o));
  const expected = [...sameRank].map((f) => keyOf(f)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let tiebreakByContentKey = true;
  for (let i = 0; i < runs; i++) {
    const ordering = byPrecedence(shuffle(sameRank, 100 + i), CUR).map(keyOf);
    if (ordering.join("|") !== expected.join("|")) {
      tiebreakByContentKey = false;
      detail.push(`  ✗ determinism: equal-rank tiebreak not by contentKey (seed ${100 + i})`);
    }
  }
  detail.push(
    `  ${tiebreakByContentKey ? "✓" : "✗"} equal-rank facts tiebreak deterministically by contentKey`,
  );

  return { runs, stable, tiebreakByContentKey };
}

// ---- section 3: resolveConflicts semantics ----------------------------------

function runResolveSemantics(detail: string[]): SectionResult {
  let cases = 0;
  let passed = 0;
  const check = (label: string, ok: boolean) => {
    cases += 1;
    if (ok) passed += 1;
    detail.push(`  ${ok ? "✓" : "✗"} ${label}`);
  };

  // a) Single-fact group passes through untouched, no conflict.
  {
    const only = fact({ object: "npm" });
    const res = resolveConflicts([{ fact: only, score: 1 }], CUR);
    check(
      "single-fact group passes through (no false conflict)",
      res.resolved.length === 1 &&
        res.resolved[0]!.fact.fact_id === only.fact_id &&
        res.conflicts.length === 0,
    );
  }

  // b) Same value from multiple sources collapses to one winner, NO conflict note.
  {
    const a = rankFact(7, "npm"); // agent inference, same value
    const b = rankFact(3, "npm"); // workspace decision, same value
    const res = resolveConflicts(
      [
        { fact: a, score: 1 },
        { fact: b, score: 1 },
      ],
      CUR,
    );
    check(
      "same value, multiple sources collapses to one winner with NO false conflict",
      res.resolved.length === 1 &&
        res.resolved[0]!.fact.object === "npm" &&
        res.conflicts.length === 0,
    );
    // The retained winner should be the highest-precedence of the duplicates.
    check(
      "same-value collapse keeps the highest-precedence duplicate",
      res.resolved.length === 1 && res.resolved[0]!.fact.fact_id === b.fact_id,
    );
  }

  // c) Genuine contradiction surfaces EXACTLY one conflict; winner wins; loser
  //    suppressed from resolved; winReason is correct + human-readable.
  {
    const winner = rankFact(1, "pnpm"); // current-session user instruction
    const loser = rankFact(7, "npm"); // agent inference
    const res = resolveConflicts(
      [
        { fact: loser, score: 2 },
        { fact: winner, score: 1 },
      ],
      CUR,
    );
    const winnerWon = res.resolved.length === 1 && res.resolved[0]!.fact.fact_id === winner.fact_id;
    const loserHidden = !res.resolved.some((s) => s.fact.fact_id === loser.fact_id);
    const exactlyOne = res.conflicts.length === 1;
    const summary = res.conflicts[0]?.summary ?? "";
    const reasonOk =
      summary.includes('"pnpm"') &&
      summary.includes('"npm"') &&
      summary.includes("wins over") &&
      summary.includes("current-session user instruction") &&
      summary.includes("agent inference");
    check("genuine contradiction: winner wins", winnerWon);
    check("genuine contradiction: loser suppressed from resolved", loserHidden);
    check("genuine contradiction: EXACTLY one conflict note surfaced", exactlyOne);
    check("genuine contradiction: winReason is correct + human-readable", reasonOk);
  }

  // d) Independent (subject,predicate) groups resolve independently.
  {
    const g1w = rankFact(1, "pnpm");
    const g1l = rankFact(7, "npm");
    const g2w = fact({ subject: "repo", predicate: "test_cmd", object: "vitest" });
    const res = resolveConflicts(
      [
        { fact: g1l, score: 1 },
        { fact: g2w, score: 1 },
        { fact: g1w, score: 1 },
      ],
      CUR,
    );
    const pmWinner = res.resolved.find((s) => s.fact.predicate === "package_manager");
    const tcWinner = res.resolved.find((s) => s.fact.predicate === "test_cmd");
    check(
      "independent groups: each (subject,predicate) resolves separately",
      res.resolved.length === 2 &&
        pmWinner?.fact.object === "pnpm" &&
        tcWinner?.fact.object === "vitest" &&
        res.conflicts.length === 1,
    );
  }

  // e) Loser is NEVER silently dropped (it is surfaced as a conflict note).
  {
    const winner = rankFact(2, "pnpm");
    const loser = rankFact(8, "npm");
    const res = resolveConflicts(
      [
        { fact: winner, score: 1 },
        { fact: loser, score: 1 },
      ],
      CUR,
    );
    check(
      "loser never silently dropped — contradiction is surfaced",
      res.conflicts.length === 1 && res.resolved.length === 1,
    );
  }

  return { cases, passed };
}

// ---- section 4: reconcileWrite matrix ---------------------------------------

// Ancestry oracle mirroring real git `isAncestor(a,b)` (a reachable from b).
// c0 -> c1 -> c2 is a linear chain; cX is an isolated commit (no relation).
const ANCESTRY: Record<string, string[]> = {
  c0: ["c0"],
  c1: ["c0", "c1"],
  c2: ["c0", "c1", "c2"],
  cX: ["cX"],
};
const isAncestor = (a: string, b: string) => ANCESTRY[b]?.includes(a) ?? false;

interface ReconcileCase {
  label: string;
  intent: Parameters<typeof reconcileWrite>[0];
  current: Fact | null;
  expect: ConcurrencyOutcome["kind"];
  contradiction: boolean; // genuine contradictory values? (silent-LWW counts only here)
}

const RECONCILE_CASES: ReconcileCase[] = [
  // --- apply paths ---
  {
    label: "no current fact → apply",
    intent: { fact: fact({ object: "pnpm" }) },
    current: null,
    expect: "apply",
    contradiction: false,
  },
  {
    label: "writer saw current version (base_seen matches) → apply",
    intent: { base_seen_fact_id: "f1", fact: fact({ object: "pnpm" }) },
    current: fact({ fact_id: "f1", object: "npm" }),
    expect: "apply",
    contradiction: false,
  },
  {
    label: "idempotent apply: base_seen matches even though values differ",
    intent: { base_seen_fact_id: "f1", fact: fact({ object: "totally-different" }) },
    current: fact({ fact_id: "f1", object: "npm" }),
    expect: "apply",
    contradiction: false,
  },
  {
    label: "idempotent same-value write (stale base, identical value) → apply",
    intent: { base_seen_fact_id: "stale", fact: fact({ object: "npm" }) },
    current: fact({ fact_id: "f2", object: "npm" }),
    expect: "apply",
    contradiction: false,
  },
  // --- partition paths ---
  {
    label: "branch-disjoint contradictory writes → partition (no silent winner)",
    intent: {
      base_seen_fact_id: "stale",
      branch: "feat",
      fact: fact({ object: "pnpm", git: { branch: "feat" } }),
    },
    current: fact({ fact_id: "f3", object: "npm", git: { branch: "main" } }),
    expect: "partition",
    contradiction: true,
  },
  {
    label: "branch from fact.git (intent.branch unset) still partitions",
    intent: {
      base_seen_fact_id: "stale",
      fact: fact({ object: "yarn", git: { branch: "feat-2" } }),
    },
    current: fact({ fact_id: "f3b", object: "npm", git: { branch: "main" } }),
    expect: "partition",
    contradiction: true,
  },
  // --- invalidate paths ---
  {
    label: "high-trust structured supersedes prose (base is ancestor) → invalidate",
    intent: {
      base_seen_fact_id: "stale",
      base_git_head: "c1",
      fact: fact({
        object: "pnpm",
        trust_tier: "high",
        source: { asserted_by: "deterministic_parser", event_ids: [] },
      }),
    },
    current: fact({
      fact_id: "f4",
      object: "npm",
      trust_tier: "low",
      git: { valid_from_commit: "c0" },
    }),
    expect: "invalidate",
    contradiction: true,
  },
  // --- disputed paths (adversarial edges the old suite missed) ---
  {
    label: "ambiguous same-branch contradiction → disputed (NOT silent LWW)",
    intent: { base_seen_fact_id: "stale", fact: fact({ object: "pnpm" }) },
    current: fact({ fact_id: "f5", object: "yarn" }),
    expect: "disputed",
    contradiction: true,
  },
  {
    label: "high-trust vs high-trust contradiction → disputed (must NOT silently invalidate)",
    intent: {
      base_seen_fact_id: "stale",
      base_git_head: "c1",
      fact: fact({
        object: "pnpm",
        trust_tier: "high",
        source: { asserted_by: "deterministic_parser", event_ids: [] },
      }),
    },
    current: fact({
      fact_id: "f6",
      object: "npm",
      trust_tier: "high",
      git: { valid_from_commit: "c0" },
    }),
    expect: "disputed",
    contradiction: true,
  },
  {
    label: "high-trust over prose but base is NOT an ancestor → disputed (no false invalidate)",
    intent: {
      base_seen_fact_id: "stale",
      base_git_head: "cX",
      fact: fact({
        object: "pnpm",
        trust_tier: "high",
        source: { asserted_by: "deterministic_parser", event_ids: [] },
      }),
    },
    current: fact({
      fact_id: "f7",
      object: "npm",
      trust_tier: "low",
      git: { valid_from_commit: "c1" },
    }),
    expect: "disputed",
    contradiction: true,
  },
  {
    label: "one-sided branch (only intent has a branch) → disputed (cannot confirm disjoint)",
    intent: {
      base_seen_fact_id: "stale",
      branch: "feat",
      fact: fact({ object: "pnpm", git: { branch: "feat" } }),
    },
    current: fact({ fact_id: "f8", object: "npm" }),
    expect: "disputed",
    contradiction: true,
  },
  {
    label: "one-sided branch (only current has a branch) → disputed (cannot confirm disjoint)",
    intent: { base_seen_fact_id: "stale", fact: fact({ object: "pnpm" }) },
    current: fact({ fact_id: "f9", object: "npm", git: { branch: "main" } }),
    expect: "disputed",
    contradiction: true,
  },
  {
    label: "low-trust intent vs high-trust current (no invalidate) → disputed",
    intent: {
      base_seen_fact_id: "stale",
      base_git_head: "c1",
      fact: fact({ object: "pnpm", trust_tier: "low" }),
    },
    current: fact({
      fact_id: "f10",
      object: "npm",
      trust_tier: "high",
      git: { valid_from_commit: "c0" },
    }),
    expect: "disputed",
    contradiction: true,
  },
];

function runReconcile(detail: string[]): { section: SectionResult; silentWrongWinners: number } {
  let cases = 0;
  let passed = 0;
  let silentWrongWinners = 0;
  for (const c of RECONCILE_CASES) {
    cases += 1;
    const out = reconcileWrite(c.intent, c.current, isAncestor);
    const ok = out.kind === c.expect;
    if (ok) passed += 1;
    // A silent wrong winner = a GENUINE contradiction resolved as a plain apply.
    if (c.contradiction && out.kind === "apply") silentWrongWinners += 1;
    detail.push(`  ${ok ? "✓" : "✗"} ${c.label} (got ${out.kind})`);
  }
  return { section: { cases, passed }, silentWrongWinners };
}

// ---- section 5: real Runtime concurrent-session stress ----------------------

interface DurableWriterSpec {
  sessionId: string;
  object: string;
  branch: string;
  trustTier?: Fact["trust_tier"];
  assertedBy?: Fact["source"]["asserted_by"];
  baseGitHead?: string;
  validFromCommit?: string;
}

interface ConcurrentCase {
  label: string;
  first: DurableWriterSpec;
  second: DurableWriterSpec;
  expectSecond: ConcurrencyOutcome["kind"];
}

const CONCURRENT_CASES: ConcurrentCase[] = [
  {
    label: "same-branch stale writers dispute",
    first: { sessionId: "race-a", object: "pnpm", branch: "main", trustTier: "low" },
    second: { sessionId: "race-b", object: "yarn", branch: "main", trustTier: "low" },
    expectSecond: "disputed",
  },
  {
    label: "branch-disjoint stale writers partition",
    first: { sessionId: "race-a", object: "pnpm", branch: "main", trustTier: "low" },
    second: { sessionId: "race-b", object: "yarn", branch: "feat", trustTier: "low" },
    expectSecond: "partition",
  },
  {
    label: "structured stale writer invalidates lower-trust current",
    first: {
      sessionId: "race-a",
      object: "npm",
      branch: "main",
      trustTier: "low",
      validFromCommit: "c0",
    },
    second: {
      sessionId: "race-b",
      object: "pnpm",
      branch: "main",
      trustTier: "high",
      assertedBy: "deterministic_parser",
      baseGitHead: "c1",
    },
    expectSecond: "invalidate",
  },
];

function runConcurrentStress(detail: string[]): ConcurrentStressResult {
  let cases = 0;
  let passed = 0;
  let silentOverwrites = 0;
  const outcomes: Record<string, number> = {};

  for (const c of CONCURRENT_CASES) {
    cases += 1;
    const result = runConcurrentCase(c);
    outcomes[result.secondOutcome] = (outcomes[result.secondOutcome] ?? 0) + 1;
    if (result.silentOverwrite) silentOverwrites += 1;
    const ok =
      result.firstOutcome === "apply" &&
      result.secondOutcome === c.expectSecond &&
      !result.silentOverwrite &&
      result.loserAuditable;
    if (ok) passed += 1;
    detail.push(
      `  ${ok ? "✓" : "✗"} concurrent writers: ${c.label} → first=${result.firstOutcome} second=${result.secondOutcome} silentOverwrite=${result.silentOverwrite} loserAuditable=${result.loserAuditable}`,
    );
  }

  detail.push(
    `  ${silentOverwrites === 0 ? "✓" : "✗"} concurrent writers: ${silentOverwrites} silent overwrites across ${cases} real Runtime races`,
  );
  return { cases, passed, silentOverwrites, outcomes };
}

function runConcurrentCase(c: ConcurrentCase): {
  firstOutcome: ConcurrencyOutcome["kind"];
  secondOutcome: ConcurrencyOutcome["kind"];
  silentOverwrite: boolean;
  loserAuditable: boolean;
} {
  const dir = mkdtempSync(join(tmpdir(), "graphctx-conflict-"));
  const seed = new Runtime({ workspaceDir: dir, userId: "conflict-eval" });
  const writerA = new Runtime({ workspaceDir: dir, userId: "conflict-eval" });
  const writerB = new Runtime({ workspaceDir: dir, userId: "conflict-eval" });
  const inspector = new Runtime({ workspaceDir: dir, userId: "conflict-eval" });
  try {
    const base = insertRuntimeFact(seed, {
      sessionId: "race-base",
      object: "base",
      branch: "main",
      trustTier: "low",
      validFromCommit: "c0",
    });
    const first = applyDurableWrite(writerA, {
      spec: c.first,
      baseSeenFactId: base.fact_id,
      current: base,
    });
    const currentForSecond = currentDurableFact(writerB) ?? first.fact;
    const second = applyDurableWrite(writerB, {
      spec: c.second,
      baseSeenFactId: base.fact_id,
      current: currentForSecond,
    });
    const audit = auditConcurrentResult(inspector, currentForSecond, second.fact, second.outcome);
    return {
      firstOutcome: first.outcome.kind,
      secondOutcome: second.outcome.kind,
      silentOverwrite: audit.silentOverwrite,
      loserAuditable: audit.loserAuditable,
    };
  } finally {
    seed.close();
    writerA.close();
    writerB.close();
    inspector.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function applyDurableWrite(
  rt: Runtime,
  opts: { spec: DurableWriterSpec; baseSeenFactId: string; current: Fact | null },
): { fact: Fact; outcome: ConcurrencyOutcome } {
  const intentFact = runtimeIntentFact(rt, opts.spec);
  const outcome = reconcileWrite(
    {
      base_seen_fact_id: opts.baseSeenFactId,
      base_git_head: opts.spec.baseGitHead,
      branch: opts.spec.branch,
      fact: intentFact,
    },
    opts.current,
    isAncestor,
  );
  const inserted = insertRuntimeFact(
    rt,
    opts.spec,
    outcome.kind === "disputed" ? "disputed" : "active",
  );
  applyDurableOutcome(rt, inserted, opts.current, outcome);
  return { fact: rt.facts.get(inserted.fact_id) ?? inserted, outcome };
}

function insertRuntimeFact(
  rt: Runtime,
  spec: DurableWriterSpec,
  status: Fact["status"] = "active",
): Fact {
  return rt.facts.insert({
    subject: "repo",
    predicate: "package_manager",
    object: spec.object,
    fact_kind: "constraint",
    temporal_kind: "static",
    scope: rt.scope(spec.sessionId),
    trust_tier: spec.trustTier ?? "low",
    status,
    promotion_state: "workspace_active",
    source: { asserted_by: spec.assertedBy ?? "user", event_ids: [] },
    git: { branch: spec.branch, valid_from_commit: spec.validFromCommit },
  });
}

function runtimeIntentFact(rt: Runtime, spec: DurableWriterSpec): Fact {
  return fact({
    subject: "repo",
    predicate: "package_manager",
    object: spec.object,
    scope: rt.scope(spec.sessionId),
    status: "active",
    promotion_state: "workspace_active",
    trust_tier: spec.trustTier ?? "low",
    source: { asserted_by: spec.assertedBy ?? "user", event_ids: [] },
    git: { branch: spec.branch, valid_from_commit: spec.validFromCommit },
  });
}

function applyDurableOutcome(
  rt: Runtime,
  inserted: Fact,
  current: Fact | null,
  outcome: ConcurrencyOutcome,
): void {
  if (!current) return;
  switch (outcome.kind) {
    case "apply": {
      if (objStr(inserted) !== objStr(current)) {
        rt.edges.add(inserted.fact_id, "SUPERSEDES", current.fact_id, inserted.fact_id);
        rt.edges.add(current.fact_id, "SUPERSEDED_BY", inserted.fact_id, inserted.fact_id);
        rt.facts.update(current.fact_id, {
          status: "superseded",
          invalidated_by: inserted.fact_id,
        });
      }
      return;
    }
    case "partition":
      return;
    case "invalidate": {
      rt.edges.add(inserted.fact_id, "INVALIDATES", current.fact_id, inserted.fact_id);
      rt.facts.expire(current.fact_id, inserted.fact_id, "c1");
      return;
    }
    case "disputed": {
      rt.edges.add(inserted.fact_id, "CONFLICTS_WITH", current.fact_id, inserted.fact_id);
      rt.facts.update(current.fact_id, {
        status: "disputed",
        contradiction_count: current.contradiction_count + 1,
      });
      return;
    }
  }
}

function currentDurableFact(rt: Runtime): Fact | null {
  const active = rt.facts
    .bySubjectPredicate("repo", "package_manager", { user_id: rt.userId })
    .filter((f) => f.status === "active" && f.promotion_state === "workspace_active");
  active.sort((a, b) => {
    const byTime = a.time.t_recorded.localeCompare(b.time.t_recorded);
    if (byTime !== 0) return byTime;
    return a.fact_id.localeCompare(b.fact_id);
  });
  return active.at(-1) ?? null;
}

function auditConcurrentResult(
  rt: Runtime,
  current: Fact,
  incoming: Fact,
  outcome: ConcurrencyOutcome,
): { silentOverwrite: boolean; loserAuditable: boolean } {
  const currentAfter = rt.facts.get(current.fact_id);
  const incomingAfter = rt.facts.get(incoming.fact_id);
  const bothPersisted = currentAfter !== null && incomingAfter !== null;
  const edgeCount =
    rt.edges.touching(current.fact_id).length + rt.edges.touching(incoming.fact_id).length;
  const loserAuditable =
    bothPersisted &&
    (outcome.kind === "partition" ||
      currentAfter.status === "expired" ||
      currentAfter.status === "superseded" ||
      currentAfter.status === "disputed" ||
      incomingAfter.status === "disputed" ||
      edgeCount > 0);
  const silentOverwrite = outcome.kind === "apply" || !bothPersisted || !loserAuditable;
  return { silentOverwrite, loserAuditable };
}

// ---- top-level runner -------------------------------------------------------

export function runParallelConflictEval(): ParallelConflictReport {
  const detail: string[] = [];

  detail.push("[1] precedence ladder (cross-product of all 9 ranks)");
  const ladder = runLadder(detail);

  detail.push("");
  detail.push("[2] determinism / total ordering");
  const determinism = runDeterminism(detail);

  detail.push("");
  detail.push("[3] resolveConflicts semantics");
  const resolve = runResolveSemantics(detail);

  detail.push("");
  detail.push("[4] reconcileWrite matrix (apply / partition / invalidate / disputed)");
  const { section: reconcile, silentWrongWinners } = runReconcile(detail);

  detail.push("");
  detail.push("[5] real Runtime concurrent-session stress");
  const concurrent = runConcurrentStress(detail);

  const determinismCases = 2; // stable total order + equal-rank tiebreak
  const determinismPassed =
    (determinism.stable ? 1 : 0) + (determinism.tiebreakByContentKey ? 1 : 0);

  const cases = ladder.pairs + determinismCases + resolve.cases + reconcile.cases;
  const passed = ladder.passed + determinismPassed + resolve.passed + reconcile.passed;

  return {
    cases,
    passed,
    silentWrongWinners,
    ladder,
    determinism,
    resolve,
    reconcile,
    concurrent,
    detail,
    pass:
      passed === cases &&
      silentWrongWinners === 0 &&
      concurrent.passed === concurrent.cases &&
      concurrent.silentOverwrites === 0,
  };
}

export function formatParallelConflictReport(r: ParallelConflictReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval — parallel-conflict & precedence (SPEC §14, M3)");
  lines.push("=".repeat(72));
  lines.push("");
  for (const d of r.detail) lines.push(d.startsWith("  ") || d === "" ? d : `  ${d}`);
  lines.push("");
  lines.push("  ── headline ──────────────────────────────────────────────────────");
  lines.push(`  precedence ladder:     ${r.ladder.passed}/${r.ladder.pairs} ordered rank pairs`);
  lines.push(
    `  determinism:           stable=${r.determinism.stable} tiebreakByContentKey=${r.determinism.tiebreakByContentKey} (${r.determinism.runs} shuffles)`,
  );
  lines.push(`  resolveConflicts:      ${r.resolve.passed}/${r.resolve.cases} semantics cases`);
  lines.push(`  reconcileWrite matrix: ${r.reconcile.passed}/${r.reconcile.cases} cases`);
  lines.push(
    `  concurrent stress:     ${r.concurrent.passed}/${r.concurrent.cases} real Runtime races, silentOverwrites: ${r.concurrent.silentOverwrites}`,
  );
  lines.push(
    `  cases: ${r.passed}/${r.cases}   silent wrong winners: ${r.silentWrongWinners} (must be 0)`,
  );
  lines.push(
    r.pass
      ? "  VERDICT: ✅ no silent LWW — full precedence ladder holds; conflicts partition/dispute/surface correctly; concurrent writers preserve auditability."
      : "  VERDICT: ❌ parallel-conflict FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

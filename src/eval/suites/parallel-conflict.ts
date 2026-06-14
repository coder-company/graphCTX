import type { Fact, ScoredFact } from "../../core/types.js";
import {
  type ConcurrencyOutcome,
  reconcileWrite,
  resolveConflicts,
} from "../../resolve/conflicts.js";

// Parallel-conflict (SPEC §14, M3 gate). Two sessions write contradictory durable
// values concurrently. The engine must NEVER silently pick a last-writer-wins
// winner: branch-disjoint writes partition, a deterministic high-trust write
// supersedes prose, and a genuinely ambiguous contradiction is marked DISPUTED.
// At injection, precedence resolution must surface the conflict, not hide it.
export interface ParallelConflictReport {
  cases: number;
  passed: number;
  silentWrongWinners: number; // ambiguous contradictions silently resolved (want 0)
  detail: string[];
  pass: boolean;
}

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

const ANCESTRY: Record<string, string[]> = { c0: ["c0"], c1: ["c0", "c1"] };
const isAncestor = (a: string, b: string) => ANCESTRY[b]?.includes(a) ?? false;

interface ReconcileCase {
  label: string;
  intent: Parameters<typeof reconcileWrite>[0];
  current: Fact | null;
  expect: ConcurrencyOutcome["kind"];
}

const RECONCILE_CASES: ReconcileCase[] = [
  {
    label: "no concurrent change → apply",
    intent: { base_seen_fact_id: "f1", fact: fact({ object: "pnpm" }) },
    current: fact({ fact_id: "f1", object: "npm" }),
    expect: "apply",
  },
  {
    label: "branch-disjoint contradictory writes → partition (no silent winner)",
    intent: {
      base_seen_fact_id: "stale",
      branch: "feat",
      fact: fact({ object: "pnpm", git: { branch: "feat" } }),
    },
    current: fact({ fact_id: "f2", object: "npm", git: { branch: "main" } }),
    expect: "partition",
  },
  {
    label: "high-trust structured supersedes prose → invalidate",
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
      fact_id: "f3",
      object: "npm",
      trust_tier: "low",
      git: { valid_from_commit: "c0" },
    }),
    expect: "invalidate",
  },
  {
    label: "ambiguous same-branch contradiction → disputed (NOT silent LWW)",
    intent: { base_seen_fact_id: "stale", fact: fact({ object: "pnpm" }) },
    current: fact({ fact_id: "f4", object: "yarn" }),
    expect: "disputed",
  },
];

export function runParallelConflictEval(): ParallelConflictReport {
  const detail: string[] = [];
  let passed = 0;
  let silentWrongWinners = 0;

  for (const c of RECONCILE_CASES) {
    const out = reconcileWrite(c.intent, c.current, isAncestor);
    const ok = out.kind === c.expect;
    if (ok) passed += 1;
    // A silent wrong winner = an ambiguous contradiction resolved as a plain apply.
    if (c.expect === "disputed" && out.kind === "apply") silentWrongWinners += 1;
    detail.push(`${ok ? "✓" : "✗"} ${c.label} (got ${out.kind})`);
  }

  // Injection-time precedence: a current-session user instruction must win over
  // older agent inference, and the conflict must be SURFACED (not hidden).
  const userNow = fact({
    object: "pnpm",
    scope: { user_id: "u", workspace_id: "w", session_id: "s1" },
    source: { asserted_by: "user", event_ids: [] },
  });
  const agentOld = fact({ object: "npm", source: { asserted_by: "agent", event_ids: [] } });
  const scored: ScoredFact[] = [
    { fact: agentOld, score: 2 },
    { fact: userNow, score: 1 },
  ];
  const res = resolveConflicts(scored, "s1");
  const winnerIsUser = res.resolved.length === 1 && res.resolved[0]!.fact.object === "pnpm";
  const surfaced = res.conflicts.length === 1;
  const precOk = winnerIsUser && surfaced;
  if (precOk) passed += 1;
  detail.push(
    `${precOk ? "✓" : "✗"} precedence: user-now beats agent-old AND conflict surfaced (winner=${res.resolved[0]?.fact.object}, conflicts=${res.conflicts.length})`,
  );

  const cases = RECONCILE_CASES.length + 1;
  return {
    cases,
    passed,
    silentWrongWinners,
    detail,
    pass: passed === cases && silentWrongWinners === 0,
  };
}

export function formatParallelConflictReport(r: ParallelConflictReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval — parallel-conflict (M3)");
  lines.push("=".repeat(72));
  lines.push("");
  for (const d of r.detail) lines.push(`  ${d}`);
  lines.push("");
  lines.push(
    `  cases: ${r.passed}/${r.cases}   silent wrong winners: ${r.silentWrongWinners} (must be 0)`,
  );
  lines.push(
    r.pass
      ? "  VERDICT: ✅ no silent LWW — conflicts partition/dispute/surface correctly."
      : "  VERDICT: ❌ parallel-conflict FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

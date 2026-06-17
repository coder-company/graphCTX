import type { ScoredFact } from "../core/types.js";
import type { DB } from "../store/db.js";

// Local-only outcome telemetry (SPEC §21). Classifies whether an injected capsule
// HELPED, was IGNORED, or appeared HARMFUL, based on what happened next in the
// session. Pure heuristic over local events — NEVER leaves the machine
// (config.telemetry.local_only). Feeds future learned scoring (v2).
export type OutcomeClass = "helped" | "ignored" | "harmful" | "unknown";

export type OutcomeSummary = Record<OutcomeClass, number>;

export interface OutcomeLearningStats extends OutcomeSummary {
  fact_id: string;
  total: number;
  adjustment: number;
}

export interface OutcomeLearningOptions {
  minObservations?: number;
  maxAdjustment?: number;
}

export interface OutcomeSignal {
  // A tool/command after the injection succeeded (suggests the context helped).
  followedBySuccess?: boolean;
  // A repeated failure of the same command after injection (context didn't help
  // or actively misled → harmful).
  repeatedFailure?: boolean;
  // The agent referenced an injected fact_id / [mem:*] marker downstream.
  referencedInjectedFact?: boolean;
  // No observable effect at all.
  noEffect?: boolean;
}

export function classifyOutcome(sig: OutcomeSignal): OutcomeClass {
  if (sig.repeatedFailure) return "harmful";
  if (sig.referencedInjectedFact || sig.followedBySuccess) return "helped";
  if (sig.noEffect) return "ignored";
  return "unknown";
}

const OUTCOME_WEIGHTS: Record<OutcomeClass, number> = {
  helped: 1,
  ignored: -0.2,
  harmful: -1,
  unknown: 0,
};

export class OutcomeRecorder {
  private readonly db: DB;
  private readonly enabled: boolean;

  constructor(db: DB, opts: { enabled?: boolean } = {}) {
    this.db = db;
    this.enabled = opts.enabled ?? true;
  }

  // Persist a classified outcome onto the injection row (local-only).
  record(injectionId: string, sig: OutcomeSignal): OutcomeClass {
    const outcome = classifyOutcome(sig);
    if (!this.enabled) return outcome;
    try {
      this.db
        .prepare("UPDATE injections SET outcome_json = ? WHERE injection_id = ?")
        .run(JSON.stringify({ outcome, signals: sig, at: new Date().toISOString() }), injectionId);
    } catch {
      // telemetry must never break anything (I9)
    }
    return outcome;
  }

  // Aggregate counts per outcome class for local inspection.
  summary(): OutcomeSummary {
    const counts = emptySummary();
    try {
      const rows = this.db
        .prepare("SELECT outcome_json FROM injections WHERE outcome_json IS NOT NULL")
        .all() as Array<{ outcome_json: string }>;
      for (const r of rows) {
        const outcome = parseOutcome(r.outcome_json);
        if (outcome) counts[outcome] += 1;
      }
    } catch {
      // table/column missing → empty summary
    }
    return counts;
  }
}

export function loadOutcomeLearningStats(
  db: DB,
  opts: OutcomeLearningOptions = {},
): Map<string, OutcomeLearningStats> {
  const minObservations = opts.minObservations ?? 1;
  const maxAdjustment = opts.maxAdjustment ?? 0.75;
  const byFact = new Map<string, OutcomeLearningStats>();
  try {
    const rows = db
      .prepare(
        `SELECT selected_fact_ids_json, outcome_json
         FROM injections
         WHERE outcome_json IS NOT NULL`,
      )
      .all() as Array<{ selected_fact_ids_json: string; outcome_json: string }>;
    for (const row of rows) {
      const outcome = parseOutcome(row.outcome_json);
      const factIds = parseFactIds(row.selected_fact_ids_json);
      if (!outcome || factIds.length === 0) continue;
      for (const factId of factIds) {
        const stats = byFact.get(factId) ?? newStats(factId);
        stats[outcome] += 1;
        stats.total += 1;
        byFact.set(factId, stats);
      }
    }
  } catch {
    return byFact;
  }

  for (const stats of byFact.values()) {
    stats.adjustment =
      stats.total >= minObservations
        ? clamp(weightedMean(stats), -maxAdjustment, maxAdjustment)
        : 0;
  }
  return byFact;
}

export function rerankWithOutcomeLearning(
  scored: ScoredFact[],
  db: DB,
  opts: OutcomeLearningOptions = {},
): ScoredFact[] {
  return applyOutcomeLearning(scored, loadOutcomeLearningStats(db, opts));
}

export function applyOutcomeLearning(
  scored: ScoredFact[],
  stats: Map<string, OutcomeLearningStats>,
): ScoredFact[] {
  return scored
    .map((s) => {
      const adjustment = stats.get(s.fact.fact_id)?.adjustment ?? 0;
      return {
        ...s,
        score: s.score * (1 + adjustment),
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.fact.fact_id.localeCompare(b.fact.fact_id);
    });
}

function emptySummary(): OutcomeSummary {
  return {
    helped: 0,
    ignored: 0,
    harmful: 0,
    unknown: 0,
  };
}

function newStats(factId: string): OutcomeLearningStats {
  return {
    fact_id: factId,
    ...emptySummary(),
    total: 0,
    adjustment: 0,
  };
}

function parseOutcome(raw: string): OutcomeClass | null {
  try {
    const o = JSON.parse(raw) as { outcome?: string };
    return isOutcome(o.outcome) ? o.outcome : null;
  } catch {
    return null;
  }
}

function parseFactIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function isOutcome(v: unknown): v is OutcomeClass {
  return v === "helped" || v === "ignored" || v === "harmful" || v === "unknown";
}

function weightedMean(stats: OutcomeSummary & { total: number }): number {
  if (stats.total === 0) return 0;
  return (
    (stats.helped * OUTCOME_WEIGHTS.helped +
      stats.ignored * OUTCOME_WEIGHTS.ignored +
      stats.harmful * OUTCOME_WEIGHTS.harmful +
      stats.unknown * OUTCOME_WEIGHTS.unknown) /
    stats.total
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

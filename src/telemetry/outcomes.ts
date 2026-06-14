import type { DB } from "../store/db.js";

// Local-only outcome telemetry (SPEC §21). Classifies whether an injected capsule
// HELPED, was IGNORED, or appeared HARMFUL, based on what happened next in the
// session. Pure heuristic over local events — NEVER leaves the machine
// (config.telemetry.local_only). Feeds future learned scoring (v2).
export type OutcomeClass = "helped" | "ignored" | "harmful" | "unknown";

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
  summary(): Record<OutcomeClass, number> {
    const counts: Record<OutcomeClass, number> = {
      helped: 0,
      ignored: 0,
      harmful: 0,
      unknown: 0,
    };
    try {
      const rows = this.db
        .prepare("SELECT outcome_json FROM injections WHERE outcome_json IS NOT NULL")
        .all() as Array<{ outcome_json: string }>;
      for (const r of rows) {
        try {
          const o = JSON.parse(r.outcome_json) as { outcome?: OutcomeClass };
          if (o.outcome && o.outcome in counts) counts[o.outcome] += 1;
        } catch {
          // skip malformed
        }
      }
    } catch {
      // table/colum missing → empty summary
    }
    return counts;
  }
}

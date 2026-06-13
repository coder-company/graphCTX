import type { Fact, PromotionState } from "../core/types.js";
import { anchorAtHead } from "../git/anchors.js";
import { verifyBeforeInject } from "../inject/staleness.js";
import type { EdgesRepo } from "../store/edges.repo.js";
import type { FactsRepo } from "../store/facts.repo.js";
import type { PromotionsRepo } from "../store/promotions.repo.js";
import { type Decision, type PromotionContext, sessionToWorkspace } from "./gates.js";

export interface ProbationDeps {
  facts: FactsRepo;
  edges: EdgesRepo;
  promotions: PromotionsRepo;
  workspaceDir: string;
  minProcedureSuccesses: number;
  minFailureRepeats: number;
  // Optional lookup for procedure success counts (procedures table).
  procSuccesses?: (factId: string) => number;
  // Optional current git context to commit-anchor promoted facts (M1 §4).
  git?: { repoId: string; head: string; branch: string };
}

export interface SweepResult {
  considered: number;
  promoted: number;
  heldCandidate: number;
  rejected: number;
  decisions: Array<{ fact_id: string; decision: Decision }>;
}

// Promotion sweep (SPEC §12). Runs over session-scoped candidate facts and
// applies the hard gates. Promotion to workspace requires, in addition to a
// gate firing: clean lifecycle, no unresolved conflict, and — for perishable
// facts — passing synchronous verification (probation discipline).
export class Probation {
  private readonly deps: ProbationDeps;

  constructor(deps: ProbationDeps) {
    this.deps = deps;
  }

  sweepSessionToWorkspace(scope: {
    user_id: string;
    workspace_id?: string;
    session_id?: string;
  }): SweepResult {
    const result: SweepResult = {
      considered: 0,
      promoted: 0,
      heldCandidate: 0,
      rejected: 0,
      decisions: [],
    };

    // Candidates eligible for graduation: not yet at workspace/user scope.
    const pool = this.deps.facts
      .all(scope)
      .filter(
        (f) => f.promotion_state === "session_only" || f.promotion_state === "workspace_candidate",
      );

    for (const f of pool) {
      result.considered += 1;
      const ctx = this.contextFor(f);
      const decision = sessionToWorkspace(f, ctx);

      // Extra probation guard: never promote a perishable fact whose target is
      // gone, even if a gate fired (I4).
      const verified =
        decision.kind === "promote" ? verifyBeforeInject(f, this.deps.workspaceDir) : true;
      const finalDecision: Decision =
        decision.kind === "promote" && !verified
          ? {
              kind: "candidate",
              gate: "unverified",
              reason: "perishable target failed verification",
            }
          : decision;

      this.applyDecision(f, finalDecision);
      result.decisions.push({ fact_id: f.fact_id, decision: finalDecision });
      if (finalDecision.kind === "promote") result.promoted += 1;
      else if (finalDecision.kind === "candidate") result.heldCandidate += 1;
      else result.rejected += 1;
    }

    return result;
  }

  private contextFor(f: Fact): PromotionContext {
    const conflicts = this.deps.edges
      .touching(f.fact_id)
      .filter((e) => e.edge_kind === "CONFLICTS_WITH");
    return {
      hasUnresolvedConflict: f.status === "disputed" || conflicts.length > 0,
      procSuccesses: this.deps.procSuccesses?.(f.fact_id) ?? 0,
      // evidence_count is our cross-session observation proxy in M1.
      sessionsObserved: f.evidence_count,
      minProcedureSuccesses: this.deps.minProcedureSuccesses,
      minFailureRepeats: this.deps.minFailureRepeats,
    };
  }

  private applyDecision(f: Fact, decision: Decision): void {
    const from = f.promotion_state;
    let to: PromotionState = from;

    if (decision.kind === "promote") {
      to = "workspace_active";
      this.deps.facts.update(f.fact_id, {
        promotion_state: to,
        status: "active",
        last_verified_at: new Date().toISOString(),
      });
      // Commit-anchor every promoted fact so it is commit-valid (M1 §4, I5).
      if (this.deps.git) {
        this.deps.facts.setAnchor(f.fact_id, anchorAtHead(f.git, this.deps.git));
      }
    } else if (decision.kind === "candidate") {
      to = "workspace_candidate";
      // hold as candidate (do not activate); only move state if advancing.
      if (from === "session_only") {
        this.deps.facts.update(f.fact_id, { promotion_state: to, status: "candidate" });
      }
    } else {
      // reject: leave session-local; record the decision for audit.
      to = from;
    }

    this.deps.promotions.record({
      fact_id: f.fact_id,
      from_state: from,
      to_state: to,
      decision: decision.kind,
      gate: decision.gate,
      reason: decision.reason,
    });
  }
}

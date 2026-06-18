import type { Fact } from "../core/types.js";
import type { EdgesRepo } from "../store/edges.repo.js";
import type { EpisodesRepo } from "../store/episodes.repo.js";
import type { FactsRepo } from "../store/facts.repo.js";
import { type LlmInvalidationAgent, nullLlmAgent } from "./llm-agent.js";
import { type Relation, type RelationContext, classifyRelation } from "./relation.js";

export interface InvalidatorDeps {
  facts: FactsRepo;
  edges: EdgesRepo;
  episodes?: EpisodesRepo;
  llm?: LlmInvalidationAgent;
  workspaceDir?: string;
  currentBranch?: string;
  currentHead?: string;
}

export interface InvalidationAction {
  relation: Relation;
  existingFactId: string;
  applied: string; // human-readable effect
}

export interface InvalidationResult {
  factId: string;
  actions: InvalidationAction[];
}

// The invalidation engine (SPEC §11). Call AFTER a new fact is inserted to keep
// memory coherent: classify the new fact against existing same-subject/predicate
// facts and apply the relation's effect (expire/supersede/dispute/override).
export class Invalidator {
  private readonly deps: InvalidatorDeps;
  private readonly llm: LlmInvalidationAgent;

  constructor(deps: InvalidatorDeps) {
    this.deps = deps;
    this.llm = deps.llm ?? nullLlmAgent;
  }

  async processIncomingFact(incoming: Fact): Promise<InvalidationResult> {
    const actions: InvalidationAction[] = [];
    const ctx: RelationContext = {
      workspaceDir: this.deps.workspaceDir,
      currentBranch: this.deps.currentBranch,
    };

    const candidates = this.retrievePotentialConflicts(incoming);

    for (const existing of candidates) {
      if (existing.fact_id === incoming.fact_id) continue;
      if (existing.status === "expired" || existing.status === "superseded") continue;

      let verdict = classifyRelation(incoming, existing, ctx);

      // LLM fallback ONLY when deterministic rules abstain.
      if (!verdict.deterministic && verdict.relation === "unrelated") {
        const llmRel = await this.consultLlm(incoming, existing);
        if (llmRel)
          verdict = {
            relation: llmRel,
            reason: "llm (cited evidence verified)",
            deterministic: false,
          };
      }

      const applied = this.apply(incoming, existing, verdict.relation);
      if (applied)
        actions.push({ relation: verdict.relation, existingFactId: existing.fact_id, applied });
    }

    return { factId: incoming.fact_id, actions };
  }

  // Candidates: same subject+predicate within overlapping scope.
  private retrievePotentialConflicts(f: Fact): Fact[] {
    return this.deps.facts.bySubjectPredicate(f.subject, f.predicate, {
      user_id: f.scope.user_id,
    });
  }

  // Consult the LLM fallback with the two HARD post-checks (SPEC §11):
  //  1. must cite >=1 evidence id;
  //  2. every cited id must EXIST in the episode store (no world-knowledge
  //     invalidation). Verdicts that fail either check are rejected → abstain.
  private async consultLlm(incoming: Fact, existing: Fact): Promise<Relation | null> {
    const verdict = await this.llm.classify(incoming, existing);
    if (!verdict) return null;

    // Only `invalidates`/`conflicts` require evidence; benign relations don't.
    const requiresEvidence = verdict.relation === "invalidates" || verdict.relation === "conflicts";
    if (!requiresEvidence) return verdict.relation;

    if (!verdict.cited_evidence_ids || verdict.cited_evidence_ids.length === 0) return null;
    if (!this.deps.episodes) return null; // cannot verify → reject (conservative)
    const allExist = verdict.cited_evidence_ids.every(
      (id) => this.deps.episodes!.byId(id) !== null,
    );
    return allExist ? verdict.relation : null;
  }

  private apply(incoming: Fact, existing: Fact, relation: Relation): string | null {
    return this.deps.facts.transaction(() => this.applyInTransaction(incoming, existing, relation));
  }

  private applyInTransaction(incoming: Fact, existing: Fact, relation: Relation): string | null {
    const { facts, edges } = this.deps;
    switch (relation) {
      case "same": {
        facts.update(existing.fact_id, {
          evidence_count: existing.evidence_count + incoming.evidence_count,
        });
        edges.add(existing.fact_id, "SUPPORTED_BY", incoming.fact_id, incoming.fact_id);
        edges.add(incoming.fact_id, "SUPERSEDED_BY", existing.fact_id, existing.fact_id);
        facts.supersede(incoming.fact_id, existing.fact_id, this.deps.currentHead);
        return "merged evidence into existing fact and retired duplicate";
      }
      case "refines": {
        edges.add(incoming.fact_id, "SUPERSEDES", existing.fact_id, incoming.fact_id);
        edges.add(existing.fact_id, "SUPERSEDED_BY", incoming.fact_id, incoming.fact_id);
        facts.supersede(existing.fact_id, incoming.fact_id, this.deps.currentHead);
        return "superseded older value";
      }
      case "invalidates": {
        edges.add(incoming.fact_id, "INVALIDATES", existing.fact_id, incoming.fact_id);
        facts.expire(existing.fact_id, incoming.fact_id, this.deps.currentHead);
        return "expired stale fact at current commit";
      }
      case "conflicts": {
        edges.add(incoming.fact_id, "CONFLICTS_WITH", existing.fact_id, incoming.fact_id);
        facts.update(incoming.fact_id, {
          status: "disputed",
          contradiction_count: incoming.contradiction_count + 1,
        });
        facts.update(existing.fact_id, {
          status: "disputed",
          contradiction_count: existing.contradiction_count + 1,
        });
        return "marked both disputed";
      }
      case "coexists": {
        // repo-over-user gets an OVERRIDES edge for precedence at injection.
        if (incoming.scope.workspace_id && existing.promotion_state.startsWith("user_")) {
          edges.add(incoming.fact_id, "OVERRIDES", existing.fact_id, incoming.fact_id);
          return "added OVERRIDES edge (repo > user)";
        }
        return "partitioned by scope/branch (no change)";
      }
      default:
        return null;
    }
  }

  // Resolve an open loop (or any fact) so it stops being injected. When a
  // separate resolving fact exists, link provenance with SUPERSEDED_BY; a plain
  // user resolution has no new fact to point at, so do not create a self-edge.
  resolve(resolvedFactId: string, byFactId?: string): void {
    if (byFactId) {
      this.deps.edges.add(resolvedFactId, "SUPERSEDED_BY", byFactId, byFactId);
      this.deps.facts.supersede(resolvedFactId, byFactId, this.deps.currentHead);
      return;
    }
    this.deps.facts.supersede(resolvedFactId, undefined, this.deps.currentHead);
  }
}

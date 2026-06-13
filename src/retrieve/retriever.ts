import type { Fact, InjectionContext, ScoredFact } from "../core/types.js";
import { isValidAsOf } from "../git/anchors.js";
import type { Git } from "../git/git.js";
import type { FactsRepo } from "../store/facts.repo.js";
import { fuse } from "./rank.js";
import { entityScore, scopeWeight } from "./signals.js";
import { type VectorIndex, distanceToScore } from "./vectors.js";

export interface RetrieveOptions {
  // For SessionStart/PostCompact we also want a broad "all active workspace facts"
  // pass even when the query is sparse.
  includeAllActive?: boolean;
  k?: number;
}

// Multi-signal retrieval (M1 = vector ∪ BM25 + entity + scope) composed across
// scopes, then commit-anchored + active filtering (SPEC §13). The vector signal
// degrades to BM25-only when the index is disabled.
export class Retriever {
  private readonly repo: FactsRepo;
  private readonly git: Git | null;
  private readonly vectors: VectorIndex | null;

  constructor(repo: FactsRepo, git: Git | null, vectors: VectorIndex | null = null) {
    this.repo = repo;
    this.git = git;
    this.vectors = vectors;
  }

  async retrieve(ctx: InjectionContext, opts: RetrieveOptions = {}): Promise<ScoredFact[]> {
    const k = opts.k ?? 60;
    const query = buildQuery(ctx);
    const entities = collectEntities(ctx);

    const wsScope = { user_id: ctx.scope.user_id, workspace_id: ctx.scope.workspace_id };
    const userScope = { user_id: ctx.scope.user_id };

    const pool = new Map<string, ScoredFact>();
    const add = (sf: ScoredFact, boost: number) => {
      const w = scopeWeight(sf.fact, ctx.scope.session_id);
      const eb = entityScore(sf.fact, entities) * 0.5;
      const score = (sf.score + eb + boost) * w;
      const prev = pool.get(sf.fact.fact_id);
      if (!prev || score > prev.score) {
        pool.set(sf.fact.fact_id, {
          fact: sf.fact,
          score,
          signals: { ...sf.signals, entity: eb, scope: w },
        });
      }
    };

    // BM25 over workspace + session + user scopes.
    if (query) {
      for (const sf of this.repo.search({ text: query, scope: wsScope, limit: k })) add(sf, 0);
      if (ctx.scope.session_id) {
        for (const sf of this.repo.search({
          text: query,
          scope: { user_id: ctx.scope.user_id, session_id: ctx.scope.session_id },
          limit: k,
        }))
          add(sf, 0.1);
      }
      for (const sf of this.repo.search({ text: query, scope: userScope, limit: 15 })) add(sf, 0);
    }

    // Broad active pass for boot/compaction events (empty space to fill).
    if (opts.includeAllActive) {
      for (const f of this.repo.activeAsOf(wsScope)) {
        add({ fact: f, score: 0.3 }, 0);
      }
      if (ctx.scope.session_id) {
        for (const f of this.repo.activeAsOf({
          user_id: ctx.scope.user_id,
          session_id: ctx.scope.session_id,
        }))
          add({ fact: f, score: 0.5 }, 0.1);
      }
    }

    // Semantic (vector) signal — hybrid with BM25 (SPEC §13, §624-625). Applied
    // as an ADDITIVE boost layered on the existing pool: it improves recall and
    // re-ranking for semantically-relevant facts without displacing what BM25 /
    // the broad pass already surfaced (so hybrid recall >= BM25-only). Disabled
    // index → no-op → pure BM25 fallback.
    if (query && this.vectors?.enabled) {
      const hits = this.vectors.search(query, k);
      const ranks = new Map<string, number>();
      hits.forEach((h, i) => ranks.set(h.fact_id, i));
      for (const hit of hits) {
        const existing = pool.get(hit.fact_id);
        const semBoost = distanceToScore(hit.distance) * 0.35;
        if (existing) {
          existing.score += semBoost;
          existing.signals = { ...existing.signals, semantic: hit.distance };
        } else {
          const f = this.repo.get(hit.fact_id);
          if (!f || f.status !== "active") continue;
          if (!inScope(f, wsScope.user_id, wsScope.workspace_id, ctx.scope.session_id)) continue;
          const w = scopeWeight(f, ctx.scope.session_id);
          pool.set(f.fact_id, {
            fact: f,
            score: semBoost * w,
            signals: { semantic: hit.distance, scope: w },
          });
        }
      }
    }

    // Commit-anchored filtering (SPEC §8, §13).
    const all = [...pool.values()];
    const valid: ScoredFact[] = [];
    for (const sf of all) {
      if (await this.isValid(sf.fact, ctx)) valid.push(sf);
    }
    return fuse(valid);
  }

  private async isValid(fact: Fact, ctx: InjectionContext): Promise<boolean> {
    if (fact.status !== "active") return false;
    if (!fact.git || !this.git) return true;
    try {
      return await isValidAsOf(this.git, fact.git, ctx.git.head, ctx.git.branch);
    } catch {
      return true; // degrade open: if git check fails, don't drop the fact
    }
  }
}

function buildQuery(ctx: InjectionContext): string {
  return [ctx.user_prompt, ctx.transcript_tail, planText(ctx)]
    .filter(Boolean)
    .join(" ")
    .slice(0, 4000);
}

function planText(ctx: InjectionContext): string {
  if (!ctx.planned_tool) return "";
  const args = ctx.planned_tool.args ? JSON.stringify(ctx.planned_tool.args) : "";
  return `${ctx.planned_tool.name} ${args}`;
}

function collectEntities(ctx: InjectionContext): string[] {
  const e = new Set<string>();
  for (const f of ctx.current_files ?? []) e.add(f);
  for (const s of ctx.mentioned_symbols ?? []) e.add(s);
  return [...e];
}

// A vector hit is valid only within the active retrieval scopes (workspace or
// the current session) — vectors span the whole DB, so we must scope-filter.
function inScope(
  f: Fact,
  userId: string,
  workspaceId: string | undefined,
  sessionId: string | undefined,
): boolean {
  if (f.scope.user_id !== userId) return false;
  if (f.scope.workspace_id && workspaceId && f.scope.workspace_id === workspaceId) return true;
  if (f.scope.session_id && sessionId && f.scope.session_id === sessionId) return true;
  // user-scoped facts (no workspace/session) are also eligible
  return !f.scope.workspace_id && !f.scope.session_id;
}

import type { Fact, InjectionContext, ScoredFact } from "../core/types.js";
import { isValidAsOf } from "../git/anchors.js";
import type { Git } from "../git/git.js";
import type { FactsRepo } from "../store/facts.repo.js";
import { contentKey, fuse } from "./rank.js";
import { entityScore, scopeWeight } from "./signals.js";
import type { VectorIndex } from "./vectors.js";

// Bounded semantic expansion limits (keep the hot path flat at scale). The cap
// bounds the embed-rerank scan for sparse queries; the max-distance gate avoids
// surfacing weak semantic matches as noise.
const SEMANTIC_SCAN_CAP = 512;
const SEMANTIC_MAX_DIST = 1.05;

// Reciprocal Rank Fusion (RRF, Cormack 2009) constants. We fuse BM25/lexical and
// semantic signals by RANK position rather than by raw score — BM25 and cosine
// distance live on incompatible scales, so a weighted-average over raw scores is
// fragile. RRF_score(d) = Σ_i 1/(RRF_K + rank_i(d)) over each retriever i the
// doc appears in. RRF_K=60 is the canonical constant used by Elasticsearch /
// Azure AI Search / OpenSearch / Milvus. CONSENSUS_BOOST gently lifts docs found
// by BOTH retrievers (independent agreement is a relevance signal); it is sized
// to ≈ a fraction of one rank step (1/RRF_K) so it only breaks near-ties.
const RRF_K = 60;
const CONSENSUS_BOOST = 0.5 / RRF_K;

// Entity-overlap influence, applied as a gentle post-RRF multiplier
// (1 + ENTITY_WEIGHT * entityScore) so path/symbol matches still help rank
// without overpowering the fused order.
const ENTITY_WEIGHT = 0.5;

// A retrieval candidate accumulates the per-retriever signals needed to build
// each ranked list. `lexScore` is the (scope/entity-folded) lexical relevance
// used to rank the lexical list (higher = better); `semDist` is cosine distance
// used to rank the semantic list (lower = better). `foundLex`/`foundSem` mark
// which retriever(s) surfaced the fact, for the consensus boost.
interface Candidate {
  fact: Fact;
  lexScore: number;
  semDist: number;
  foundLex: boolean;
  foundSem: boolean;
  scope: number;
  entity: number;
  bm25?: number;
}

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

    // Candidate union keyed by fact_id. Each candidate accumulates the signals
    // for BOTH ranked lists (lexical + semantic); RRF fuses by rank afterward.
    const cand = new Map<string, Candidate>();
    const ensure = (f: Fact): Candidate => {
      let c = cand.get(f.fact_id);
      if (!c) {
        c = {
          fact: f,
          lexScore: Number.NEGATIVE_INFINITY,
          semDist: Number.POSITIVE_INFINITY,
          foundLex: false,
          foundSem: false,
          scope: scopeWeight(f, ctx.scope.session_id),
          entity: entityScore(f, entities),
        };
        cand.set(f.fact_id, c);
      }
      return c;
    };
    // Record a lexical (BM25 / broad-pass) hit. `lex` is a lexical relevance
    // where higher = better; we keep the strongest across the scope passes.
    const addLex = (f: Fact, lex: number, bm25?: number) => {
      const c = ensure(f);
      c.foundLex = true;
      if (lex > c.lexScore) {
        c.lexScore = lex;
        if (bm25 !== undefined) c.bm25 = bm25;
      }
    };

    // BM25 over workspace + session + user scopes. repo.search() collapses its
    // public `score` to ~1 for every hit (positive-clamped bm25), so the real
    // lexical relevance lives in signals.bm25 (raw FTS5 bm25: lower = better).
    // We rank the lexical list by -bm25 so genuine relevance — not mere
    // presence — sets the order. Scope/entity are kept as post-RRF multipliers.
    if (query) {
      for (const sf of this.repo.search({ text: query, scope: wsScope, limit: k }))
        addLex(sf.fact, lexFromSignals(sf), sf.signals?.bm25);
      if (ctx.scope.session_id) {
        for (const sf of this.repo.search({
          text: query,
          scope: { user_id: ctx.scope.user_id, session_id: ctx.scope.session_id },
          limit: k,
        }))
          addLex(sf.fact, lexFromSignals(sf), sf.signals?.bm25);
      }
      for (const sf of this.repo.search({ text: query, scope: userScope, limit: 15 }))
        addLex(sf.fact, lexFromSignals(sf), sf.signals?.bm25);
    }

    // Broad active pass for boot/compaction events (empty space to fill). These
    // are "active fill", not query matches, so they enter the lexical list with
    // a small fixed relevance that sorts below real BM25 hits.
    if (opts.includeAllActive) {
      for (const f of this.repo.activeAsOf(wsScope)) addLex(f, 0.3);
      if (ctx.scope.session_id) {
        for (const f of this.repo.activeAsOf({
          user_id: ctx.scope.user_id,
          session_id: ctx.scope.session_id,
        }))
          addLex(f, 0.5);
      }
    }

    // Semantic (vector) signal — hybrid with BM25 (SPEC §13, §624-625). We build
    // a RANKED semantic list (by cosine distance) over the candidate pool plus a
    // bounded expansion, then fuse by RANK (RRF) below — NOT by adding a scaled
    // raw score (incompatible scales). We re-rank the bounded candidate POOL
    // (retrieve-then-rerank) rather than an O(N) full-table vec0 KNN scan, so
    // vector cost stays O(candidates) and the hot path stays flat at scale.
    // Disabled index → no semantic list → pure lexical RRF (BM25 fallback, I9).
    if (query && this.vectors?.enabled) {
      try {
        const qv = this.vectors.embedQuery(query);
        // 1) Re-rank the lexical candidate pool (always cheap: O(pool)).
        for (const c of cand.values()) {
          const dist = this.vectors.cosineDistanceTo(qv, String(c.fact.object));
          c.semDist = dist;
          c.foundSem = true;
        }
        // 2) Bounded semantic expansion: when the lexical pass surfaced few
        // candidates (a sparse/short query, or one whose answer shares no
        // keywords — e.g. "which package manager" → "pnpm"), embed-rerank a
        // CAPPED slice of active facts to recover pure-semantic matches. The cap
        // keeps this O(SEMANTIC_SCAN_CAP), not O(N), so the hot path stays flat.
        if (cand.size < k) {
          let scanned = 0;
          const semCandidates: Array<{ fact: Fact; dist: number }> = [];
          for (const f of this.repo.activeAsOf(wsScope)) {
            if (scanned >= SEMANTIC_SCAN_CAP) break;
            scanned++;
            if (cand.has(f.fact_id)) continue;
            const dist = this.vectors.cosineDistanceTo(qv, String(f.object));
            semCandidates.push({ fact: f, dist });
          }
          semCandidates.sort((a, b) => a.dist - b.dist);
          for (const sc of semCandidates.slice(0, k)) {
            if (sc.dist > SEMANTIC_MAX_DIST) continue;
            if (!inScope(sc.fact, wsScope.user_id, wsScope.workspace_id, ctx.scope.session_id))
              continue;
            const c = ensure(sc.fact);
            c.semDist = sc.dist;
            c.foundSem = true;
          }
        }
      } catch {
        // semantic re-rank is best-effort; lexical ordering stands on failure
      }
    }

    // Reciprocal Rank Fusion: derive each retriever's RANKED list, then fuse by
    // rank position (Cormack 2009). Ties within a list break on the stable
    // content key so the rank order is deterministic run-to-run.
    const candidates = [...cand.values()];
    const lexRank = rankBy(
      candidates.filter((c) => c.foundLex),
      (a, b) => b.lexScore - a.lexScore,
    );
    const semRank = rankBy(
      candidates.filter((c) => c.foundSem),
      (a, b) => a.semDist - b.semDist,
    );

    // Commit-anchored filtering (SPEC §8, §13), then RRF-score the survivors.
    const valid: ScoredFact[] = [];
    for (const c of candidates) {
      if (!(await this.isValid(c.fact, ctx))) continue;
      let rrf = 0;
      const rl = lexRank.get(c.fact.fact_id);
      const rs = semRank.get(c.fact.fact_id);
      if (rl !== undefined) rrf += 1 / (RRF_K + rl);
      if (rs !== undefined) rrf += 1 / (RRF_K + rs);
      // Consensus: independent agreement from both retrievers is a relevance
      // signal — gently lift docs surfaced by BOTH lists.
      if (rl !== undefined && rs !== undefined) rrf += CONSENSUS_BOOST;
      // Preserve scope + entity influence as gentle multipliers on the fused
      // rank score (session/workspace scope and entity matches still help).
      const score = rrf * c.scope * (1 + ENTITY_WEIGHT * c.entity);
      valid.push({
        fact: c.fact,
        score,
        signals: {
          bm25: c.bm25,
          entity: c.entity,
          semantic: c.foundSem ? c.semDist : undefined,
          scope: c.scope,
        },
      });
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

// Lexical relevance for ranking the BM25 list. repo.search() returns the raw
// FTS5 bm25 in signals.bm25 (lower = better), so we negate it; fall back to the
// collapsed positive score when bm25 is absent (e.g. broad active-pass fills).
function lexFromSignals(sf: ScoredFact): number {
  const bm = sf.signals?.bm25;
  return bm !== undefined ? -bm : sf.score;
}

// Build a 1-based rank map from a candidate list. Sort by the given comparator,
// breaking ties on the stable content key so ranks are deterministic.
function rankBy(
  list: Candidate[],
  cmp: (a: Candidate, b: Candidate) => number,
): Map<string, number> {
  const sorted = [...list].sort((a, b) => {
    const d = cmp(a, b);
    if (d !== 0) return d;
    const ka = contentKey(a.fact);
    const kb = contentKey(b.fact);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const ranks = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) ranks.set(sorted[i]!.fact.fact_id, i + 1);
  return ranks;
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

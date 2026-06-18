import { type Clock, systemClock } from "../core/clock.js";
import { factId } from "../core/ids.js";
import type {
  Fact,
  FactMeta,
  GitAnchor,
  NewFact,
  PromotionState,
  ScopeFilter,
  ScoredFact,
} from "../core/types.js";
import { redactSecrets, sensitivityForText } from "../security/secrets.js";
import { type DB, tx } from "./db.js";

interface FactRow {
  fact_id: string;
  subject_id: string;
  predicate: string;
  object_json: string;
  fact_kind: string;
  temporal_kind: string;
  scope_user_id: string;
  scope_workspace_id: string | null;
  scope_session_id: string | null;
  status: string;
  promotion_state: string;
  trust_tier: string;
  sensitivity: string;
  confidence: number;
  evidence_count: number;
  contradiction_count: number;
  injection_count: number;
  last_verified_at: string | null;
  last_injected_at: string | null;
  t_observed: string | null;
  t_created: string;
  t_recorded: string;
  t_expired: string | null;
  invalidated_by: string | null;
  asserted_by: string;
  source_event_ids_json: string;
  source_commit: string | null;
  raw_quote: string | null;
  tags_json: string;
}

interface AnchorRow {
  fact_id: string;
  repo_id: string | null;
  branch: string | null;
  base_head: string | null;
  introduced_by_commit: string | null;
  valid_from_commit: string | null;
  valid_until_commit: string | null;
  invalidated_by_commit: string | null;
  path_globs_json: string | null;
  file_ids_json: string | null;
  symbol_ids_json: string | null;
  hunk_fingerprints_json: string | null;
  patch_id: string | null;
}

export interface FtsQuery {
  text: string;
  scope: ScopeFilter;
  limit?: number;
}

function rowToFact(row: FactRow, anchor?: AnchorRow): Fact {
  const fact: Fact = {
    fact_id: row.fact_id,
    subject: row.subject_id,
    predicate: row.predicate,
    object: JSON.parse(row.object_json),
    fact_kind: row.fact_kind as Fact["fact_kind"],
    temporal_kind: row.temporal_kind as Fact["temporal_kind"],
    scope: {
      user_id: row.scope_user_id,
      workspace_id: row.scope_workspace_id ?? undefined,
      session_id: row.scope_session_id ?? undefined,
    },
    status: row.status as Fact["status"],
    promotion_state: row.promotion_state as PromotionState,
    trust_tier: row.trust_tier as Fact["trust_tier"],
    sensitivity: row.sensitivity as Fact["sensitivity"],
    confidence: row.confidence,
    evidence_count: row.evidence_count,
    contradiction_count: row.contradiction_count,
    injection_count: row.injection_count,
    last_verified_at: row.last_verified_at ?? undefined,
    last_injected_at: row.last_injected_at ?? undefined,
    time: {
      t_observed: row.t_observed ?? row.t_recorded,
      t_created: row.t_created,
      t_recorded: row.t_recorded,
      t_expired: row.t_expired ?? undefined,
      invalidated_by: row.invalidated_by ?? undefined,
    },
    source: {
      asserted_by: row.asserted_by as Fact["source"]["asserted_by"],
      event_ids: JSON.parse(row.source_event_ids_json),
      commit: row.source_commit ?? undefined,
      raw_quote: row.raw_quote ?? undefined,
    },
    tags: JSON.parse(row.tags_json),
  };
  if (anchor) {
    fact.git = anchorRowToGit(anchor);
  }
  return fact;
}

function tryRowToFact(row: FactRow, anchor?: AnchorRow): Fact | null {
  try {
    return rowToFact(row, anchor);
  } catch {
    return null;
  }
}

function anchorRowToGit(a: AnchorRow): GitAnchor {
  const parseArr = (s: string | null): string[] | undefined => {
    if (!s) return undefined;
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    repo_id: a.repo_id ?? undefined,
    branch: a.branch ?? undefined,
    base_head: a.base_head ?? undefined,
    introduced_by_commit: a.introduced_by_commit ?? undefined,
    valid_from_commit: a.valid_from_commit ?? undefined,
    valid_until_commit: a.valid_until_commit ?? undefined,
    invalidated_by_commit: a.invalidated_by_commit ?? undefined,
    path_globs: parseArr(a.path_globs_json),
    file_ids: parseArr(a.file_ids_json),
    symbol_ids: parseArr(a.symbol_ids_json),
    hunk_fingerprints: parseArr(a.hunk_fingerprints_json),
    patch_id: a.patch_id ?? undefined,
  };
}

// Minimal interface the repo needs from a vector index (avoids a hard import
// cycle and keeps the index optional / swappable).
export interface FactVectorSink {
  upsert(factId: string, text: string): void;
  remove(factId: string): void;
}

export class FactsRepo {
  private readonly db: DB;
  private readonly clock: Clock;
  private vectors: FactVectorSink | null = null;

  constructor(db: DB, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  // Attach a vector index so writes keep the semantic index in sync (M1).
  attachVectorIndex(sink: FactVectorSink): void {
    this.vectors = sink;
  }

  transaction<T>(fn: () => T): T {
    return tx(this.db, fn);
  }

  // I1: defaults to candidate / session_only unless explicitly overridden.
  insert(input: NewFact): Fact {
    const id = factId();
    const now = this.clock.iso();
    const observed = input.observed_at ?? now;
    const status = input.status ?? "candidate";
    const promotion_state = input.promotion_state ?? "session_only";
    const ftsText = `${input.subject} ${input.predicate} ${stringifyObject(input.object)} ${input.source.raw_quote ?? ""}`;
    const tags = input.tags ?? [];
    const tagsText = tags.join(" ");
    // I3 defense-in-depth: stamp sensitivity=secret at write time if the content
    // looks like a secret, unless the caller already classified it. Secrets are
    // then excluded from promotion (gates) and injection (capsule guard).
    const sensitivity =
      input.sensitivity && input.sensitivity !== "unknown"
        ? input.sensitivity
        : sensitivityForText(`${ftsText} ${tagsText}`) === "secret"
          ? "secret"
          : (input.sensitivity ?? "unknown");
    const indexedText = redactSecrets(ftsText);
    const indexedTags = redactSecrets(tagsText);

    this.db
      .prepare(
        `INSERT INTO facts (
          fact_id, subject_id, predicate, object_json, fact_kind, temporal_kind,
          scope_user_id, scope_workspace_id, scope_session_id, status, promotion_state,
          trust_tier, sensitivity, confidence, evidence_count, t_created, t_recorded,
          t_observed, asserted_by, source_event_ids_json, source_commit, raw_quote, tags_json
        ) VALUES (
          @fact_id, @subject_id, @predicate, @object_json, @fact_kind, @temporal_kind,
          @scope_user_id, @scope_workspace_id, @scope_session_id, @status, @promotion_state,
          @trust_tier, @sensitivity, @confidence, @evidence_count, @t_created, @t_recorded,
          @t_observed, @asserted_by, @source_event_ids_json, @source_commit, @raw_quote, @tags_json
        )`,
      )
      .run({
        fact_id: id,
        subject_id: input.subject,
        predicate: input.predicate,
        object_json: JSON.stringify(input.object),
        fact_kind: input.fact_kind,
        temporal_kind: input.temporal_kind,
        scope_user_id: input.scope.user_id,
        scope_workspace_id: input.scope.workspace_id ?? null,
        scope_session_id: input.scope.session_id ?? null,
        status,
        promotion_state,
        trust_tier: input.trust_tier,
        sensitivity,
        confidence: input.confidence ?? 0.5,
        evidence_count: input.evidence_count ?? 1,
        t_created: now,
        t_recorded: now,
        t_observed: observed,
        asserted_by: input.source.asserted_by,
        source_event_ids_json: JSON.stringify(input.source.event_ids),
        source_commit: input.source.commit ?? null,
        raw_quote: input.source.raw_quote ?? null,
        tags_json: JSON.stringify(tags),
      });

    this.db
      .prepare("INSERT INTO facts_fts (fact_id, text, tags) VALUES (?, ?, ?)")
      .run(id, indexedText, indexedTags);

    if (input.git) this.upsertAnchor(id, input.git);

    // Keep the semantic index in sync (no-op if no index attached).
    this.vectors?.upsert(id, `${indexedText} ${indexedTags}`);

    return this.get(id)!;
  }

  // Public anchor stamping (M1 §4): used by the promotion engine to make every
  // promoted fact commit-valid. Re-hydrates the fact afterward.
  setAnchor(fid: string, g: GitAnchor): void {
    this.upsertAnchor(fid, g);
  }

  private upsertAnchor(fid: string, g: GitAnchor): void {
    this.db
      .prepare(
        `INSERT INTO git_anchors (
          fact_id, repo_id, branch, base_head, introduced_by_commit, valid_from_commit,
          valid_until_commit, invalidated_by_commit, path_globs_json, file_ids_json,
          symbol_ids_json, hunk_fingerprints_json, patch_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fact_id) DO UPDATE SET
          repo_id=excluded.repo_id, branch=excluded.branch,
          base_head=excluded.base_head,
          introduced_by_commit=excluded.introduced_by_commit,
          valid_from_commit=excluded.valid_from_commit,
          valid_until_commit=excluded.valid_until_commit,
          invalidated_by_commit=excluded.invalidated_by_commit,
          path_globs_json=excluded.path_globs_json,
          file_ids_json=excluded.file_ids_json,
          symbol_ids_json=excluded.symbol_ids_json,
          hunk_fingerprints_json=excluded.hunk_fingerprints_json,
          patch_id=excluded.patch_id`,
      )
      .run(
        fid,
        g.repo_id ?? null,
        g.branch ?? null,
        g.base_head ?? null,
        g.introduced_by_commit ?? null,
        g.valid_from_commit ?? null,
        g.valid_until_commit ?? null,
        g.invalidated_by_commit ?? null,
        g.path_globs ? JSON.stringify(g.path_globs) : null,
        g.file_ids ? JSON.stringify(g.file_ids) : null,
        g.symbol_ids ? JSON.stringify(g.symbol_ids) : null,
        g.hunk_fingerprints ? JSON.stringify(g.hunk_fingerprints) : null,
        g.patch_id ?? null,
      );
  }

  get(id: string): Fact | null {
    const row = this.db.prepare("SELECT * FROM facts WHERE fact_id = ?").get(id) as
      | FactRow
      | undefined;
    if (!row) return null;
    const anchor = this.db.prepare("SELECT * FROM git_anchors WHERE fact_id = ?").get(id) as
      | AnchorRow
      | undefined;
    return tryRowToFact(row, anchor);
  }

  // I5: only metadata/lifecycle fields may be updated; truth is immutable.
  update(id: string, patch: FactMeta): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { fact_id: id };
    const allowed: Array<keyof FactMeta> = [
      "status",
      "promotion_state",
      "confidence",
      "evidence_count",
      "contradiction_count",
      "injection_count",
      "last_verified_at",
      "last_injected_at",
      "t_expired",
      "invalidated_by",
    ];
    for (const k of allowed) {
      if (patch[k] !== undefined) {
        sets.push(`${k} = @${k}`);
        params[k] = patch[k];
      }
    }
    if (patch.tags !== undefined) {
      sets.push("tags_json = @tags_json");
      params.tags_json = JSON.stringify(patch.tags);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE facts SET ${sets.join(", ")} WHERE fact_id = @fact_id`).run(params);
    if (patch.tags !== undefined) {
      this.syncFtsTags(id, patch.tags);
    }
  }

  private syncFtsTags(id: string, tags: string[]): void {
    const tagsText = redactSecrets(tags.join(" "));
    this.db.prepare("UPDATE facts_fts SET tags = ? WHERE fact_id = ?").run(tagsText, id);
    if (!this.vectors) return;
    const row = this.db.prepare("SELECT text FROM facts_fts WHERE fact_id = ?").get(id) as
      | { text: string }
      | undefined;
    if (row) this.vectors.upsert(id, `${row.text} ${tagsText}`);
  }

  expire(id: string, by: string, atCommit?: string): void {
    this.update(id, { status: "expired", t_expired: this.clock.iso(), invalidated_by: by });
    if (atCommit) {
      this.db
        .prepare("UPDATE git_anchors SET valid_until_commit = ? WHERE fact_id = ?")
        .run(atCommit, id);
    }
  }

  expireDueToMissingEvidence(id: string, atCommit?: string): void {
    this.update(id, { status: "expired", t_expired: this.clock.iso() });
    if (atCommit) {
      this.db
        .prepare("UPDATE git_anchors SET valid_until_commit = ? WHERE fact_id = ?")
        .run(atCommit, id);
    }
  }

  // Expired facts that carry a valid_until_commit anchor — candidates for
  // revert-driven reactivation (git/dag.ts).
  expiredWithValidUntil(): Fact[] {
    const rows = this.db
      .prepare(
        `SELECT f.* FROM facts f
         JOIN git_anchors g ON g.fact_id = f.fact_id
         WHERE f.status = 'expired' AND g.valid_until_commit IS NOT NULL`,
      )
      .all() as FactRow[];
    return this.hydrateMany(rows);
  }

  // Reactivate a fact whose invalidating commit was reverted (SPEC §8): clear
  // the expiry anchor + invalidation and mark active again.
  reactivate(id: string): void {
    this.db
      .prepare(
        "UPDATE facts SET status = 'active', t_expired = NULL, invalidated_by = NULL WHERE fact_id = ?",
      )
      .run(id);
    this.db
      .prepare(
        "UPDATE git_anchors SET valid_until_commit = NULL, invalidated_by_commit = NULL WHERE fact_id = ?",
      )
      .run(id);
  }

  bySubjectPredicate(s: string, p: string, scope: ScopeFilter): Fact[] {
    const { clause, params } = scopeClause(scope);
    const rows = this.db
      .prepare(`SELECT * FROM facts WHERE subject_id = ? AND predicate = ? ${clause}`)
      .all(s, p, ...params) as FactRow[];
    return this.hydrateMany(rows);
  }

  // Active facts in scope. Commit-anchor filtering happens in the retrieval layer.
  // An optional `limit` pushes a SQL LIMIT into the query so the bounded hot-path
  // scan loads only the first-N active rows (insertion order) instead of all N;
  // omit it to preserve the full O(N) scan for boot/compaction and eval callers.
  activeAsOf(scope: ScopeFilter, limit?: number): Fact[] {
    const { clause, params } = scopeClause(scope);
    const limitClause = limit !== undefined ? "LIMIT ?" : "";
    const allParams = limit !== undefined ? [...params, limit] : params;
    const rows = this.db
      .prepare(`SELECT * FROM facts WHERE status = 'active' ${clause} ${limitClause}`)
      .all(...allParams) as FactRow[];
    return this.hydrateMany(rows);
  }

  // Active open loops in scope (M1 §7) — durable unfinished threads that must
  // always resurface at PostCompact/SessionStart.
  openLoops(scope: ScopeFilter): Fact[] {
    const { clause, params } = scopeClause(scope);
    const rows = this.db
      .prepare(`SELECT * FROM facts WHERE status = 'active' AND fact_kind = 'open_loop' ${clause}`)
      .all(...params) as FactRow[];
    return this.hydrateMany(rows);
  }

  userScopedActive(userId: string, limit?: number): Fact[] {
    const limitClause = limit !== undefined ? "LIMIT ?" : "";
    const params = limit !== undefined ? [userId, limit] : [userId];
    const rows = this.db
      .prepare(
        `SELECT * FROM facts
         WHERE status = 'active'
           AND scope_user_id = ?
           AND scope_workspace_id IS NULL
           AND scope_session_id IS NULL
         ${limitClause}`,
      )
      .all(...params) as FactRow[];
    return this.hydrateMany(rows);
  }

  candidates(scope: ScopeFilter): Fact[] {
    const { clause, params } = scopeClause(scope);
    const rows = this.db
      .prepare(`SELECT * FROM facts WHERE status = 'candidate' ${clause}`)
      .all(...params) as FactRow[];
    return this.hydrateMany(rows);
  }

  all(scope: ScopeFilter): Fact[] {
    const { clause, params } = scopeClause(scope);
    const rows = this.db
      .prepare(`SELECT * FROM facts WHERE 1=1 ${clause}`)
      .all(...params) as FactRow[];
    return this.hydrateMany(rows);
  }

  // FTS5/BM25 search restricted to scope and active facts.
  search(opts: FtsQuery): ScoredFact[] {
    const limit = opts.limit ?? 50;
    const match = toFtsMatch(opts.text);
    if (!match) return [];
    const { clause, params } = scopeClause(opts.scope, "f.");
    const rows = this.db
      .prepare(
        `SELECT f.*, bm25(facts_fts) AS bm
         FROM facts_fts
         JOIN facts f ON f.fact_id = facts_fts.fact_id
         WHERE facts_fts MATCH ? AND f.status = 'active' ${clause}
         ORDER BY bm ASC
         LIMIT ?`,
      )
      .all(match, ...params, limit) as Array<FactRow & { bm: number }>;
    const out: ScoredFact[] = [];
    for (const row of rows) {
      const fact = this.hydrate(row);
      if (!fact) continue;
      out.push({
        fact,
        // bm25 returns lower=better (negative-ish); convert to a positive score.
        score: 1 / (1 + Math.max(0, row.bm)),
        signals: { bm25: row.bm },
      });
    }
    return out;
  }

  private hydrate(row: FactRow): Fact | null {
    const anchor = this.db
      .prepare("SELECT * FROM git_anchors WHERE fact_id = ?")
      .get(row.fact_id) as AnchorRow | undefined;
    return tryRowToFact(row, anchor);
  }

  // Batched anchor hydration: fetch every row's git anchor in ONE query per
  // chunk (SELECT ... WHERE fact_id IN (...)) instead of N+1 single-row lookups.
  // Chunked to stay under SQLite's bound-variable limit (~999). Preserves order:
  // each fact gets its own anchor (or none) keyed by fact_id.
  private hydrateMany(rows: FactRow[]): Fact[] {
    if (rows.length === 0) return [];
    const anchors = new Map<string, AnchorRow>();
    const CHUNK = 900;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      const found = this.db
        .prepare(`SELECT * FROM git_anchors WHERE fact_id IN (${placeholders})`)
        .all(...chunk.map((r) => r.fact_id)) as AnchorRow[];
      for (const a of found) anchors.set(a.fact_id, a);
    }
    const out: Fact[] = [];
    for (const row of rows) {
      const fact = tryRowToFact(row, anchors.get(row.fact_id));
      if (fact) out.push(fact);
    }
    return out;
  }
}

function stringifyObject(o: unknown): string {
  if (typeof o === "string") return o;
  return JSON.stringify(o);
}

// Build a scope WHERE fragment. Only filters on provided keys.
function scopeClause(scope: ScopeFilter, prefix = ""): { clause: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (scope.user_id !== undefined) {
    parts.push(`${prefix}scope_user_id = ?`);
    params.push(scope.user_id);
  }
  if (scope.workspace_id !== undefined) {
    parts.push(`${prefix}scope_workspace_id = ?`);
    params.push(scope.workspace_id);
  }
  if (scope.session_id !== undefined) {
    parts.push(`${prefix}scope_session_id = ?`);
    params.push(scope.session_id);
  }
  return { clause: parts.length ? `AND ${parts.join(" AND ")}` : "", params };
}

// High-frequency English function words carry no retrieval signal but, as bare
// OR terms, force BM25 to score/sort a near–full-table posting list (O(N) tail
// on non-selective queries). Dropping them is behavior-preserving: every gold
// fact is matched by its content terms, not by stopwords. Skipped only when a
// query is ALL stopwords (then we fall back to the full term set, see below).
const FTS_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "is",
  "are",
  "was",
  "were",
  "be",
  "do",
  "does",
  "did",
  "how",
  "what",
  "which",
  "who",
  "whom",
  "where",
  "when",
  "why",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "i",
  "we",
  "you",
  "they",
  "he",
  "she",
  "my",
  "our",
  "your",
  "with",
  "by",
  "from",
  "as",
  "so",
]);
export const FTS_TERM_CAP = 24;

// Sanitize free text into a safe FTS5 OR query of quoted terms.
export function toFtsMatch(text: string): string | null {
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9_.:/-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return null;
  const content = terms.filter((t) => !FTS_STOPWORDS.has(t));
  // Fall back to the full term set only if the query is ALL stopwords, so a
  // degenerate query still matches something rather than returning nothing.
  const effective = content.length > 0 ? content : terms;
  const unique = [...new Set(effective)].slice(0, FTS_TERM_CAP);
  return unique.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

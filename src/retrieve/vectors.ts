import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { DB } from "../store/db.js";

const require = createRequire(import.meta.url);

// Local-first semantic retrieval (SPEC §13, M1 item 1).
//
// graphCTX is offline-by-default, so the "embedding" is a DETERMINISTIC local
// transform — a hashed, tf-weighted, L2-normalized bag-of-words — not a network
// model call. Cosine similarity then ranks lexical/semantic overlap. This keeps
// the vector path on the hot path with ZERO network calls; a real embedding
// provider can be slotted in later behind the same interface.
//
// If sqlite-vec is unavailable for any reason, the index disables itself and the
// retriever falls back to BM25 (graceful degradation, I9).

export const EMBED_DIM = 1536;

export interface VectorHit {
  fact_id: string;
  distance: number;
}

export class VectorIndex {
  readonly enabled: boolean;
  private readonly db: DB;
  private readonly dim: number;

  constructor(db: DB, dim = EMBED_DIM) {
    this.db = db;
    this.dim = dim;
    this.enabled = this.tryInit();
  }

  private tryInit(): boolean {
    try {
      // sqlite-vec must be loaded onto the underlying connection before the
      // vec0 virtual table can be created. Best-effort: any failure disables.
      const vec = loadSqliteVec(this.db);
      if (!vec) return false;
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS fact_vectors USING vec0(fact_id TEXT PRIMARY KEY, embedding FLOAT[${this.dim}])`,
      );
      return true;
    } catch {
      return false;
    }
  }

  // Deterministic local embedding with a content-hash cache (no network).
  embed(text: string): Float32Array {
    const hash = contentHash(text);
    const cached = this.readCache(hash);
    if (cached) return cached;
    const vec = hashEmbed(text, this.dim);
    this.writeCache(hash, vec);
    return vec;
  }

  // (Re)index a fact's text. No-op when the index is disabled.
  upsert(factId: string, text: string): void {
    if (!this.enabled) return;
    try {
      const vec = this.embed(text);
      const json = toJson(vec);
      this.db.prepare("DELETE FROM fact_vectors WHERE fact_id = ?").run(factId);
      this.db
        .prepare("INSERT INTO fact_vectors(fact_id, embedding) VALUES (?, ?)")
        .run(factId, json);
    } catch {
      // indexing must never break a write path (I9)
    }
  }

  remove(factId: string): void {
    if (!this.enabled) return;
    try {
      this.db.prepare("DELETE FROM fact_vectors WHERE fact_id = ?").run(factId);
    } catch {
      // ignore
    }
  }

  // KNN search over the vec0 index. Returns [] when disabled (BM25 fallback).
  search(queryText: string, k: number): VectorHit[] {
    if (!this.enabled) return [];
    try {
      const json = toJson(this.embed(queryText));
      const rows = this.db
        .prepare(
          "SELECT fact_id, distance FROM fact_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance",
        )
        .all(json, k) as Array<{ fact_id: string; distance: number }>;
      return rows.map((r) => ({ fact_id: r.fact_id, distance: r.distance }));
    } catch {
      return [];
    }
  }

  private readCache(hash: string): Float32Array | null {
    try {
      const row = this.db
        .prepare("SELECT embedding, dim FROM embedding_cache WHERE content_hash = ?")
        .get(hash) as { embedding: Buffer; dim: number } | undefined;
      if (!row || row.dim !== this.dim) return null;
      return new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
    } catch {
      return null;
    }
  }

  private writeCache(hash: string, vec: Float32Array): void {
    try {
      const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO embedding_cache(content_hash, dim, embedding, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(hash, this.dim, buf, new Date().toISOString());
    } catch {
      // cache is best-effort
    }
  }
}

// Convert a vec0 cosine/L2 distance into a positive similarity score in (0,1].
export function distanceToScore(distance: number): number {
  return 1 / (1 + Math.max(0, distance));
}

function loadSqliteVec(db: DB): boolean {
  try {
    // Lazy require so a missing optional dep never crashes the module graph.
    const sqliteVec = require("sqlite-vec") as { load: (d: unknown) => void };
    sqliteVec.load(db);
    return true;
  } catch {
    return false;
  }
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Hashed, tf-weighted, L2-normalized bag-of-words (deterministic, local).
function hashEmbed(text: string, dim: number): Float32Array {
  const vec = new Float32Array(dim);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_.:/-]+/)
    .filter((t) => t.length >= 2);
  for (const tok of tokens) {
    const h = fnv1a(tok);
    const idx = h % dim;
    const sign = (h >>> 31) & 1 ? -1 : 1; // signed hashing reduces collisions
    vec[idx] = (vec[idx] ?? 0) + sign;
  }
  // L2 normalize so cosine == dot product.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i]! /= norm;
  }
  return vec;
}

function fnv1a(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function toJson(vec: Float32Array): string {
  return JSON.stringify(Array.from(vec));
}

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

  // Embed the query once, for re-ranking a bounded candidate set.
  embedQuery(queryText: string): Float32Array {
    return this.embed(queryText);
  }

  // Cosine distance (0..2; smaller = closer) between a precomputed query vector
  // and a candidate's text, using the deterministic local embedding (cached by
  // content hash, so repeat calls are ~free). Used by retrieve-then-rerank to
  // bound vector cost to O(candidates) instead of an O(N) full-table KNN scan.
  cosineDistanceTo(queryVec: Float32Array, text: string): number {
    const v = this.embed(text);
    let dot = 0;
    const n = Math.min(this.dim, queryVec.length, v.length);
    for (let i = 0; i < n; i++) dot += (queryVec[i] ?? 0) * (v[i] ?? 0);
    // Both vectors are L2-normalized → dot == cosine similarity in [-1, 1].
    return 1 - dot;
  }

  // KNN search over the vec0 index. Returns [] when disabled (BM25 fallback).
  // NOTE: sqlite-vec does a brute-force scan (no ANN index), so this is O(N) in
  // corpus size. Prefer cosineDistanceTo() over a BM25 candidate pool on the hot
  // path; reserve this for offline/broad passes.
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
      // Copy into a fresh, 4-byte-aligned buffer (the SQLite Buffer aliases a
      // pooled ArrayBuffer that may be misaligned — reading it in place is UB).
      const out = new Float32Array(this.dim);
      const view = new DataView(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength,
      );
      for (let i = 0; i < this.dim; i++) out[i] = view.getFloat32(i * 4, true);
      return out;
    } catch {
      return null;
    }
  }

  private writeCache(hash: string, vec: Float32Array): void {
    try {
      // Serialize little-endian explicitly so reads are stable across platforms.
      const buf = Buffer.alloc(vec.length * 4);
      for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i] ?? 0, i * 4);
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
  // The retriever may receive either our DB wrapper (with .raw) or, in unit
  // tests, a raw better-sqlite3 handle directly. Resolve the real handle.
  const handle = (db as { raw?: unknown }).raw ?? db;
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  if (isBun) {
    // Bun: load the platform vec0 extension directly onto the raw handle. The
    // .so path is resolved from an env override (set by the binary's bootstrap,
    // which extracts the embedded extension) or the bundled npm package.
    try {
      const path = resolveVecExtensionPath();
      if (!path) return false;
      (handle as { loadExtension(p: string): void }).loadExtension(path);
      return true;
    } catch {
      return false;
    }
  }
  try {
    // Node: the sqlite-vec npm package loads onto the better-sqlite3 handle.
    const sqliteVec = require("sqlite-vec") as { load: (d: unknown) => void };
    sqliteVec.load(handle);
    return true;
  } catch {
    return false;
  }
}

// Locate the vec0 loadable extension for the Bun runtime. Priority:
//   1) GRAPHCTX_VEC0_PATH env (set by the compiled binary after it extracts the
//      embedded extension to a temp dir)
//   2) the bundled sqlite-vec-<platform> npm package next to node_modules
function resolveVecExtensionPath(): string | null {
  const override = process.env.GRAPHCTX_VEC0_PATH;
  if (override) return override;
  try {
    const plat = `${process.platform}-${process.arch}`;
    const file = process.platform === "win32" ? "vec0.dll" : "vec0";
    // sqlite-vec ships per-platform packages: sqlite-vec-linux-x64, etc.
    const pkg = `sqlite-vec-${plat}`;
    const base = require.resolve(
      `${pkg}/${file}.${process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so"}`,
    );
    return base;
  } catch {
    return null;
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

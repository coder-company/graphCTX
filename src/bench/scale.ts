// Scale latency benchmark + regression gate for the retrieval hot path.
//
// SPEC §24 sets a hard budget: hot-path retrieval p95 < 150ms. The deep
// scenarios only probe up to ~5k facts; this measures the bounded per-prompt
// path (indexed BM25 + capped semantic re-rank, k-limited) at 1k → 100k facts
// so a regression at the scale the perfection bar requires fails CI loudly.
//
// We measure retriever.retrieve(ctx, { k }) ONLY — never includeAllActive,
// which is the O(N) boot/compaction scan run once per session, not per prompt.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Runtime } from "../runtime.js";
import { badge, table } from "../tui/box.js";
import { type Dist, PROBES, dist, fillerAt } from "./scenarios.js";

export const SCALE_BUDGET_MS = 150;
export const DEFAULT_SCALE_SIZES = [1000, 10000, 50000, 100000];
export const FOOTPRINT_STARTUP_BUDGET_MS = 1000;
export const FOOTPRINT_RSS_BUDGET_MB = 512;
export const FOOTPRINT_HEAP_BUDGET_MB = 256;
export const DEFAULT_FOOTPRINT_FACTS = 10000;

export interface ScalePoint {
  scaleFacts: number;
  ingestMs: number; // wall time to ingest the whole corpus
  retrievalMs: Dist; // hot-path retrieve() distribution
  budgetMs: number;
  pass: boolean; // p95 < budget
}

export interface ScaleReport {
  generatedAt: string;
  budgetMs: number;
  points: ScalePoint[];
  pass: boolean; // every probed size within budget
}

export interface FootprintReport {
  generatedAt: string;
  scaleFacts: number;
  startupMs: number;
  firstResultMs: Dist;
  rssMb: number;
  heapUsedMb: number;
  startupBudgetMs: number;
  rssBudgetMb: number;
  heapBudgetMb: number;
  resultCount: number;
  pass: boolean;
}

// Measure hot-path retrieval p50/p95/p99 at a single corpus size. Ingests
// `scaleFacts` filler distractors plus the real probes via the fast insert
// path, then times retriever.retrieve(ctx, { k }) over `repeats` × probes.
export async function measureScalePoint(
  scaleFacts: number,
  opts: { repeats?: number; k?: number; budgetMs?: number } = {},
): Promise<ScalePoint> {
  const repeats = opts.repeats ?? 25;
  const k = opts.k ?? 10;
  const budgetMs = opts.budgetMs ?? SCALE_BUDGET_MS;
  const dir = mkdtempSync(join(tmpdir(), "graphctx-scale-"));
  const rt = new Runtime({ workspaceDir: dir });
  const retr: number[] = [];
  let ingestMs = 0;
  try {
    const t0 = performance.now();
    bulkInsertBenchFacts(rt, scaleFacts);
    ingestMs = Math.round((performance.now() - t0) * 100) / 100;

    const { Retriever } = await import("../retrieve/retriever.js");
    const retriever = new Retriever(rt.facts, rt.git);
    // One warm pass primes caches/JIT before the measured window.
    for (const p of PROBES) {
      const ctx = await rt.injectionContext("UserPromptSubmit", "scale", {
        user_prompt: p.query,
        budget_tokens: 1000,
      });
      await retriever.retrieve(ctx, { k });
    }
    for (let r = 0; r < repeats; r++) {
      for (const p of PROBES) {
        const ctx = await rt.injectionContext("UserPromptSubmit", "scale", {
          user_prompt: p.query,
          budget_tokens: 1000,
        });
        const t = performance.now();
        // HOT PATH ONLY: bounded BM25 + capped semantic re-rank, k-limited.
        await retriever.retrieve(ctx, { k });
        retr.push(performance.now() - t);
      }
    }
  } finally {
    rt.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const retrievalMs = dist(retr);
  return { scaleFacts, ingestMs, retrievalMs, budgetMs, pass: retrievalMs.p95 < budgetMs };
}

// Run the scale benchmark across the given corpus sizes.
export async function runScaleBenchmark(
  opts: { sizes?: number[]; repeats?: number; k?: number; budgetMs?: number } = {},
): Promise<ScaleReport> {
  const sizes = validateScaleSizes(opts.sizes ?? DEFAULT_SCALE_SIZES);
  const budgetMs = opts.budgetMs ?? SCALE_BUDGET_MS;
  const points: ScalePoint[] = [];
  for (const n of sizes) {
    points.push(await measureScalePoint(n, { ...opts, budgetMs }));
  }
  return {
    generatedAt: new Date().toISOString(),
    budgetMs,
    points,
    pass: points.every((p) => p.pass),
  };
}

export function parseScaleSizes(raw: string): number[] {
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length === 0 || parts.some((s) => s.length === 0)) {
    throw new Error("scale benchmark requires comma-separated positive integer sizes");
  }
  return validateScaleSizes(
    parts.map((part) => {
      const n = Number(part);
      if (!Number.isSafeInteger(n) || n <= 0) {
        throw new Error(`invalid scale size "${part}"; expected a positive integer`);
      }
      return n;
    }),
  );
}

function validateScaleSizes(sizes: readonly number[]): number[] {
  if (sizes.length === 0) {
    throw new Error("scale benchmark requires at least one positive integer size");
  }
  return sizes.map((n) => {
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new Error(`invalid scale size "${n}"; expected a positive integer`);
    }
    return n;
  });
}

export async function measureFootprint(
  opts: {
    scaleFacts?: number;
    startupBudgetMs?: number;
    rssBudgetMb?: number;
    heapBudgetMb?: number;
    repeats?: number;
  } = {},
): Promise<FootprintReport> {
  const scaleFacts = opts.scaleFacts ?? DEFAULT_FOOTPRINT_FACTS;
  const startupBudgetMs = opts.startupBudgetMs ?? FOOTPRINT_STARTUP_BUDGET_MS;
  const rssBudgetMb = opts.rssBudgetMb ?? FOOTPRINT_RSS_BUDGET_MB;
  const heapBudgetMb = opts.heapBudgetMb ?? FOOTPRINT_HEAP_BUDGET_MB;
  const repeats = opts.repeats ?? 1;
  const dir = mkdtempSync(join(tmpdir(), "graphctx-footprint-"));
  try {
    const seed = new Runtime({ workspaceDir: dir });
    try {
      bulkInsertBenchFacts(seed, scaleFacts);
    } finally {
      seed.close();
    }

    const firstResultMs: number[] = [];
    let startupMs = 0;
    let resultCount = 0;
    let rssMb = 0;
    let heapUsedMb = 0;

    for (let i = 0; i < repeats; i++) {
      const t0 = performance.now();
      const rt = new Runtime({ workspaceDir: dir });
      try {
        const { Retriever } = await import("../retrieve/retriever.js");
        const retriever = new Retriever(rt.facts, rt.git);
        const ctx = await rt.injectionContext("UserPromptSubmit", `footprint-${i}`, {
          user_prompt: PROBES[0]!.query,
          budget_tokens: 1000,
        });
        const scored = await retriever.retrieve(ctx, { k: 10 });
        const elapsed = performance.now() - t0;
        firstResultMs.push(elapsed);
        if (i === 0) {
          startupMs = Math.round(elapsed * 100) / 100;
          resultCount = scored.length;
          const mem = process.memoryUsage();
          rssMb = toMb(mem.rss);
          heapUsedMb = toMb(mem.heapUsed);
        }
      } finally {
        rt.close();
      }
    }

    const distMs = dist(firstResultMs);
    const pass =
      distMs.p95 < startupBudgetMs &&
      rssMb < rssBudgetMb &&
      heapUsedMb < heapBudgetMb &&
      resultCount > 0;
    return {
      generatedAt: new Date().toISOString(),
      scaleFacts,
      startupMs,
      firstResultMs: distMs,
      rssMb,
      heapUsedMb,
      startupBudgetMs,
      rssBudgetMb,
      heapBudgetMb,
      resultCount,
      pass,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fmtN(n: number): string {
  return n.toLocaleString("en-US");
}

// Human-readable table with a PASS/FAIL verdict against the p95 budget.
export function formatScaleReport(r: ScaleReport): string {
  const out: string[] = [];
  out.push("");
  out.push(`graphCTX — scale latency (hot path, budget < ${r.budgetMs}ms p95)`);
  out.push("");
  out.push(
    ...table(
      [
        { header: "corpus size", width: 14, align: "right" },
        { header: "ingest", width: 12, align: "right" },
        { header: "p50", width: 9, align: "right" },
        { header: "p95", width: 9, align: "right" },
        { header: "p99", width: 9, align: "right" },
        { header: "verdict", width: 10, align: "right" },
      ],
      r.points.map((p) => [
        `${fmtN(p.scaleFacts)}`,
        `${fmtN(Math.round(p.ingestMs))}ms`,
        `${p.retrievalMs.p50}`,
        `${p.retrievalMs.p95}`,
        `${p.retrievalMs.p99}`,
        p.pass ? "PASS" : "FAIL",
      ]),
    ),
  );
  out.push("");
  out.push(
    r.pass
      ? `${badge("PASS", "ok")} hot-path p95 < ${r.budgetMs}ms at every probed size.`
      : `${badge("FAIL", "err")} hot-path p95 exceeded ${r.budgetMs}ms at one or more sizes.`,
  );
  return out.join("\n");
}

export function formatFootprintReport(r: FootprintReport): string {
  const out: string[] = [];
  out.push("");
  out.push("graphCTX — startup / footprint");
  out.push("");
  out.push(
    `  corpus: ${fmtN(r.scaleFacts)} facts  first-results: ${r.resultCount}  budget: startup < ${r.startupBudgetMs}ms, rss < ${r.rssBudgetMb}MB, heap < ${r.heapBudgetMb}MB`,
  );
  out.push(
    `  startup: ${r.startupMs}ms  first-result p50: ${r.firstResultMs.p50}ms  p95: ${r.firstResultMs.p95}ms  p99: ${r.firstResultMs.p99}ms`,
  );
  out.push(`  rss: ${r.rssMb}MB  heap: ${r.heapUsedMb}MB`);
  out.push("");
  out.push(
    r.pass
      ? `${badge("PASS", "ok")} startup/footprint within declared budget.`
      : `${badge("FAIL", "err")} startup/footprint exceeded declared budget.`,
  );
  return out.join("\n");
}

function bulkInsertBenchFacts(rt: Runtime, scaleFacts: number): void {
  const now = new Date().toISOString();
  const insert = rt.db.prepare(
    `INSERT INTO facts (
      fact_id, subject_id, predicate, object_json, fact_kind, temporal_kind,
      scope_user_id, scope_workspace_id, scope_session_id, status, promotion_state,
      trust_tier, sensitivity, confidence, evidence_count, t_created, t_recorded,
      asserted_by, source_event_ids_json, source_commit, raw_quote, tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = rt.db.prepare("INSERT INTO facts_fts (fact_id, text, tags) VALUES (?, ?, ?)");
  const run = rt.db.transaction((count: unknown) => {
    const n = Number(count);
    for (let i = 0; i < n; i++) {
      insertBenchFact(
        insert,
        insertFts,
        rt,
        `fact_scale_${String(i).padStart(8, "0")}`,
        fillerAt(i),
        now,
      );
    }
    for (let i = 0; i < PROBES.length; i++) {
      const p = PROBES[i]!;
      insertBenchFact(
        insert,
        insertFts,
        rt,
        `fact_probe_${String(i).padStart(3, "0")}`,
        p.fact,
        now,
      );
    }
  });
  run(scaleFacts);
}

function insertBenchFact(
  insert: { run(...params: unknown[]): unknown },
  insertFts: { run(...params: unknown[]): unknown },
  rt: Runtime,
  factId: string,
  text: string,
  now: string,
): void {
  const ftsText = `repo note ${text} ${text}`;
  insert.run(
    factId,
    "repo",
    "note",
    JSON.stringify(text),
    "decision",
    "static",
    rt.userId,
    rt.workspaceId,
    null,
    "active",
    "workspace_active",
    "high",
    "public",
    0.5,
    1,
    now,
    now,
    "user",
    "[]",
    null,
    text,
    '["bench"]',
  );
  insertFts.run(factId, ftsText, "bench");
}

function toMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

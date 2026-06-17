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
import { type Dist, PROBES, dist, filler, insertFact } from "./scenarios.js";

export const SCALE_BUDGET_MS = 150;
export const DEFAULT_SCALE_SIZES = [1000, 10000, 50000, 100000];

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
    for (const f of filler(scaleFacts)) insertFact(rt, f);
    for (const p of PROBES) insertFact(rt, p.fact);
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
  const sizes = opts.sizes ?? DEFAULT_SCALE_SIZES;
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

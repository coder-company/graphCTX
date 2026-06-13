import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Runtime } from "../runtime.js";

export interface LatencyResult {
  iterations: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  budgetMs: number;
  pass: boolean;
}

// Measures the hook hot-path latency (SPEC §24: retrieval + render < 150ms p95)
// in-process against a real grounded repo. Process spawn overhead is excluded —
// it is negligible for the compiled single-binary distribution, and including a
// tsx/Node cold start would not represent the shipped artifact.
export async function measureHookLatency(
  fixtureRepo: string,
  iterations = 50,
): Promise<LatencyResult> {
  const tmp = mkdtempSync(join(tmpdir(), "graphctx-lat-"));
  try {
    cpSync(fixtureRepo, tmp, { recursive: true });
    rmSync(join(tmp, ".graphctx"), { recursive: true, force: true });
    const rt = new Runtime({ workspaceDir: tmp, userId: "lat-user" });
    await rt.extract();

    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      // Fresh session id each iteration so the anti-repetition ledger does not
      // empty the capsule (we want to measure a full retrieve+render).
      const ctx = await rt.injectionContext("PostCompact", `lat-${i}`, {
        user_prompt: "run the tests and deploy; do not edit generated files",
        transcript_tail: "working on the feature; need the project conventions",
      });
      const start = performance.now();
      await rt.planner().plan(ctx);
      samples.push(performance.now() - start);
    }
    rt.close();

    samples.sort((a, b) => a - b);
    const pick = (q: number) =>
      samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!;
    const budgetMs = 150;
    const p95 = pick(0.95);
    return {
      iterations,
      p50: round(pick(0.5)),
      p95: round(p95),
      p99: round(pick(0.99)),
      max: round(samples[samples.length - 1]!),
      budgetMs,
      pass: p95 < budgetMs,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

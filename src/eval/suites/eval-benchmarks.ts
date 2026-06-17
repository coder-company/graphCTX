import { formatReport as formatCompareReport, runBenchmark } from "../../bench/compare.js";
import { runScaleBenchmark } from "../../bench/scale.js";
import { runEval } from "../harness.js";
import { EVAL_GATE_SUITES, type EvalGateSuite } from "../registry.js";
import { evalReportPass } from "../report.js";

const EXPECTED_SUITES: EvalGateSuite[] = [
  "run",
  "memory",
  "promote",
  "drift",
  "retrieval",
  "gate",
  "security",
  "branch",
  "temporal",
  "conflict",
  "procedure",
  "mcp",
  "storage",
  "telemetry",
  "provenance",
  "resilience",
  "benchmarks",
  "cli-docs-demo",
  "quality",
];

export interface EvalBenchmarksReport {
  checks: number;
  passed: number;
  detail: string[];
  suiteCount: number;
  ablation: {
    pullSolveRate: number;
    pushSolveRate: number;
    negativeControlsPassed: number;
    staleControlsPassed: number;
    controlRepos: number;
  };
  scorecardAxes: number;
  scaleSizes: number[];
  scaleP95: number[];
  networkCalls: number;
  pass: boolean;
}

export async function runEvalBenchmarksEval(): Promise<EvalBenchmarksReport> {
  const detail: string[] = [];
  let passed = 0;

  const check = (name: string, ok: boolean, note?: string) => {
    if (ok) passed += 1;
    detail.push(`${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
  };

  const registry = [...EVAL_GATE_SUITES];
  const missing = EXPECTED_SUITES.filter((s) => !registry.includes(s));
  const extra = registry.filter((s) => !EXPECTED_SUITES.includes(s));
  const duplicateCount = registry.length - new Set(registry).size;
  check(
    "eval suite registry contains every independent gate exactly once",
    missing.length === 0 && extra.length === 0 && duplicateCount === 0,
    `suites=${registry.length} missing=${missing.join(",") || "-"} extra=${extra.join(",") || "-"}`,
  );

  const ablation = await runEval({
    suite: "compaction-recovery",
    arms: ["A", "B", "C", "N", "S"],
  });
  const b = ablation.arms.find((a) => a.arm === "B");
  const c = ablation.arms.find((a) => a.arm === "C");
  const n = ablation.controls.find((ctrl) => ctrl.arm === "N");
  const s = ablation.controls.find((ctrl) => ctrl.arm === "S");
  const ablationPass =
    evalReportPass(ablation) &&
    !!b &&
    !!c &&
    !!n &&
    !!s &&
    c.postCompactSolveRate > b.postCompactSolveRate &&
    n.passed === n.repos &&
    s.passed === s.repos;
  check(
    "A/B/C/N/S ablation proves push beats pull with integrity controls",
    ablationPass,
    `C=${b && c ? pct(c.postCompactSolveRate) : "-"} B=${b ? pct(b.postCompactSolveRate) : "-"} N=${n ? `${n.passed}/${n.repos}` : "-"} S=${s ? `${s.passed}/${s.repos}` : "-"}`,
  );

  const offline = await withOfflineNetworkTrap(async () => {
    const compare = await runBenchmark({ live: false });
    const compareText = formatCompareReport(compare);
    const liveSkip = await runBenchmark({ live: true });
    const liveSkipText = formatCompareReport(liveSkip);
    const scale = await runScaleBenchmark({ sizes: [1000, 10000], repeats: 3 });
    return { compare, compareText, liveSkip, liveSkipText, scale };
  });

  check(
    "offline competitor scorecard renders and live bake-off skips without a key",
    offline.value.compare.axes.length >= 8 &&
      offline.value.compare.live === undefined &&
      offline.value.compareText.includes("multi-axis scorecard") &&
      offline.value.compareText.includes("Live bake-off: skipped") &&
      offline.value.liveSkip.liveSkippedReason?.includes("SUPERMEMORY_API_KEY") === true &&
      offline.value.liveSkipText.includes("export SUPERMEMORY_API_KEY"),
    `axes=${offline.value.compare.axes.length} liveSkip=${offline.value.liveSkip.liveSkippedReason ?? "-"}`,
  );

  check(
    "scale benchmark reports p50/p95/p99 and holds the latency budget at corpus growth",
    offline.value.scale.pass &&
      offline.value.scale.points.length === 2 &&
      offline.value.scale.points.every(
        (p) => p.retrievalMs.p50 > 0 && p.retrievalMs.p95 < p.budgetMs,
      ),
    offline.value.scale.points.map((p) => `${p.scaleFacts}:p95=${p.retrievalMs.p95}ms`).join(" "),
  );

  const emitted = `${offline.value.compareText}\n${offline.value.liveSkipText}`;
  check(
    "offline compare/scale make zero network calls and leak no key material",
    offline.networkCalls === 0 &&
      !/sk-ant-|sk-[A-Za-z0-9]|Bearer\s+[A-Za-z0-9_-]{8,}/.test(emitted),
    `networkCalls=${offline.networkCalls}`,
  );

  const checks = detail.length;
  const report: EvalBenchmarksReport = {
    checks,
    passed,
    detail,
    suiteCount: registry.length,
    ablation: {
      pullSolveRate: b?.postCompactSolveRate ?? 0,
      pushSolveRate: c?.postCompactSolveRate ?? 0,
      negativeControlsPassed: n?.passed ?? 0,
      staleControlsPassed: s?.passed ?? 0,
      controlRepos: n?.repos ?? s?.repos ?? 0,
    },
    scorecardAxes: offline.value.compare.axes.length,
    scaleSizes: offline.value.scale.points.map((p) => p.scaleFacts),
    scaleP95: offline.value.scale.points.map((p) => p.retrievalMs.p95),
    networkCalls: offline.networkCalls,
    pass: passed === checks && offline.networkCalls === 0,
  };
  return report;
}

export function formatEvalBenchmarksReport(r: EvalBenchmarksReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval - harness & benchmarks");
  lines.push("=".repeat(72));
  lines.push("");
  for (const d of r.detail) lines.push(`  ${d}`);
  lines.push("");
  lines.push(
    `  checks: ${r.passed}/${r.checks}   suites: ${r.suiteCount}   scorecard axes: ${r.scorecardAxes}   network calls: ${r.networkCalls}`,
  );
  lines.push(
    `  ablation: push ${pct(r.ablation.pushSolveRate)} > pull ${pct(r.ablation.pullSolveRate)}; controls N=${r.ablation.negativeControlsPassed}/${r.ablation.controlRepos} S=${r.ablation.staleControlsPassed}/${r.ablation.controlRepos}`,
  );
  lines.push(
    `  scale p95: ${r.scaleSizes.map((size, i) => `${size}=${r.scaleP95[i]}ms`).join(" ")}`,
  );
  lines.push(
    r.pass
      ? "  VERDICT: ✅ EVAL BENCHMARKS PASS - registry, ablation, scorecard, scale, and offline guards hold."
      : "  VERDICT: ❌ EVAL BENCHMARKS FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

async function withOfflineNetworkTrap<T>(fn: () => Promise<T>): Promise<{
  value: T;
  networkCalls: number;
}> {
  const holder = globalThis as unknown as { fetch?: (...args: unknown[]) => Promise<unknown> };
  const originalFetch = holder.fetch;
  const oldSupermemoryKey = process.env.SUPERMEMORY_API_KEY;
  let networkCalls = 0;
  holder.fetch = async () => {
    networkCalls += 1;
    throw new Error("network disabled in eval benchmarks");
  };
  Reflect.deleteProperty(process.env, "SUPERMEMORY_API_KEY");
  try {
    const value = await fn();
    return { value, networkCalls };
  } finally {
    if (originalFetch) holder.fetch = originalFetch;
    else Reflect.deleteProperty(holder, "fetch");
    if (oldSupermemoryKey === undefined) Reflect.deleteProperty(process.env, "SUPERMEMORY_API_KEY");
    else process.env.SUPERMEMORY_API_KEY = oldSupermemoryKey;
  }
}

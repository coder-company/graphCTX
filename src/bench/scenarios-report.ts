import { style } from "../tui/ansi.js";
import { badge, table } from "../tui/box.js";
import type { Dist, ScenarioReport } from "./scenarios.js";

function fmtDist(d: Dist): string {
  return `p50 ${d.p50}  p95 ${d.p95}  p99 ${d.p99}  (n=${d.n})`;
}

export function formatScenarios(r: ScenarioReport): string {
  const out: string[] = [];
  out.push("");
  out.push(style.bold("graphCTX — deep benchmark"));
  out.push(style.gray(`generated ${r.generatedAt}`));
  out.push("");

  // --- retrieval latency at scale ---
  out.push(style.bold("1 · retrieval latency at scale (local, ms)"));
  out.push(
    ...table(
      [
        { header: "corpus size", width: 16 },
        { header: "p50", width: 8, align: "right" },
        { header: "p95", width: 8, align: "right" },
        { header: "p99", width: 8, align: "right" },
        { header: "recall", width: 10, align: "right" },
      ],
      [
        [
          "10 facts",
          `${r.local.small.retrievalMs.p50}`,
          `${r.local.small.retrievalMs.p95}`,
          `${r.local.small.retrievalMs.p99}`,
          `${pct(r.local.small.recallHits, r.local.small.recallTotal)}`,
        ],
        [
          "510 facts",
          `${r.local.medium.retrievalMs.p50}`,
          `${r.local.medium.retrievalMs.p95}`,
          `${r.local.medium.retrievalMs.p99}`,
          `${pct(r.local.medium.recallHits, r.local.medium.recallTotal)}`,
        ],
        [
          "5,010 facts",
          `${r.local.large.retrievalMs.p50}`,
          `${r.local.large.retrievalMs.p95}`,
          `${r.local.large.retrievalMs.p99}`,
          `${pct(r.local.large.recallHits, r.local.large.recallTotal)}`,
        ],
      ],
    ),
  );
  out.push("");

  // --- local vs cloud ---
  out.push(style.bold("2 · local vs cloud (same fact set, same queries)"));
  if (r.cloud) {
    out.push(
      ...table(
        [
          { header: "system", width: 16 },
          { header: "ingest p50", width: 12, align: "right" },
          { header: "search p50", width: 12, align: "right" },
          { header: "search p95", width: 12, align: "right" },
          { header: "recall", width: 10, align: "right" },
        ],
        [
          [
            style.cyan("graphCTX"),
            `${r.local.medium.ingestMs.p50}`,
            `${r.local.medium.retrievalMs.p50}`,
            `${r.local.medium.retrievalMs.p95}`,
            `${pct(r.local.medium.recallHits, r.local.medium.recallTotal)}`,
          ],
          [
            style.magenta("supermemory"),
            `${r.cloud.ingestMs.p50}`,
            `${r.cloud.retrievalMs.p50}`,
            `${r.cloud.retrievalMs.p95}`,
            `${pct(r.cloud.recallHits, r.cloud.recallTotal)}`,
          ],
        ],
      ),
    );
    if (r.headline.speedup) {
      out.push("");
      out.push(
        `${badge("RESULT", "ok")} graphCTX retrieval is ${r.headline.speedup}× faster (p50 ${r.headline.localRetrievalP50}ms vs ${r.headline.cloudRetrievalP50}ms), offline, at $0.`,
      );
    }
  } else {
    out.push(style.gray("  cloud side skipped — set SUPERMEMORY_API_KEY for the live bake-off."));
    out.push(`  local: ingest ${fmtDist(r.local.medium.ingestMs)}`);
    out.push(`  local: search ${fmtDist(r.local.medium.retrievalMs)}`);
  }
  out.push("");

  // --- push vs pull ---
  out.push(style.bold("3 · push vs pull (the thesis — post-compaction solve)"));
  if (r.pushPull) {
    const p = r.pushPull;
    out.push(
      ...table(
        [
          { header: "arm", width: 22 },
          { header: "solved", width: 12, align: "right" },
          { header: "rate", width: 8, align: "right" },
        ],
        [
          ["A · no memory", `${p.noMemorySolve}/${p.total}`, pct(p.noMemorySolve, p.total)],
          ["B · pull (recall API)", `${p.pullSolve}/${p.total}`, pct(p.pullSolve, p.total)],
          [
            style.cyan("C · push (graphCTX)"),
            `${p.pushSolve}/${p.total}`,
            pct(p.pushSolve, p.total),
          ],
        ],
      ),
    );
  } else {
    out.push(style.gray("  push-vs-pull eval unavailable in this run dir."));
  }
  return out.join("\n");
}

function pct(n: number, d: number): string {
  return d === 0 ? "0%" : `${Math.round((n / d) * 100)}%`;
}

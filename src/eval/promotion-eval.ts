import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../runtime.js";
import { PROMOTION_CASES } from "./suites/promotion-precision.js";

export interface PromotionEvalReport {
  total: number;
  shouldPromote: number;
  promoted: number;
  truePositives: number; // promoted AND shouldPromote
  falsePositives: number; // promoted BUT NOT shouldPromote
  falseNegatives: number; // shouldPromote BUT not promoted
  precision: number; // TP / (TP + FP)
  recall: number; // TP / (TP + FN)
  precisionFloor: number;
  recallFloor: number;
  secretLeaks: number; // promoted secrets (must be 0)
  taskStateLeaks: number; // promoted task_state (must be 0)
  heldUnverified: number; // perishable facts held by probation (must be >= 1)
  pass: boolean; // precision/recall >= 0.9 AND zero leaks AND probation evidence
  rows: Array<{
    label: string;
    expected: boolean;
    promoted: boolean;
    correct: boolean;
    gate?: string;
  }>;
}

const PRECISION_GATE = 0.9;
const RECALL_GATE = 0.9;

// M1 exit gate: workspace-promotion precision >= 90% with zero secret/task_state
// leakage. Inserts a labeled fact set, runs the real probation sweep, and scores.
export async function runPromotionEval(): Promise<PromotionEvalReport> {
  const dir = mkdtempSync(join(tmpdir(), "graphctx-promo-"));
  try {
    const rt = new Runtime({ workspaceDir: dir, userId: "eval-user" });
    // Force the workspace id used by the labeled scope.
    const scope = { user_id: "eval-user", workspace_id: rt.workspaceId };

    const inserted = PROMOTION_CASES.map((c) => {
      const fact = rt.facts.insert({
        ...c.fact,
        scope,
        evidence_count: c.evidenceCount ?? 1,
      });
      if (c.procedureSuccesses) {
        const proc = rt.procedures.insert({
          fact_id: fact.fact_id,
          name: `${c.label} procedure`,
          steps: [{ description: "Run the verified procedure", command: String(c.fact.object) }],
          verifier: { command: "npm test", expected_exit_code: 0 },
        });
        for (let i = 0; i < c.procedureSuccesses; i++) {
          rt.procedures.recordSuccess(proc.procedure_id);
        }
      }
      return { c, factId: fact.fact_id };
    });

    const sweep = await rt.runPromotionSweep();
    const decisionByFact = new Map(sweep.decisions.map((d) => [d.fact_id, d.decision]));

    const rows: PromotionEvalReport["rows"] = [];
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let secretLeaks = 0;
    let taskStateLeaks = 0;
    let heldUnverified = 0;

    for (const { c, factId } of inserted) {
      const after = rt.facts.get(factId)!;
      const promoted = after.promotion_state === "workspace_active";
      const decision = decisionByFact.get(factId);

      if (promoted && c.shouldPromote) tp += 1;
      if (promoted && !c.shouldPromote) fp += 1;
      if (!promoted && c.shouldPromote) fn += 1;

      if (promoted && c.fact.sensitivity === "secret") secretLeaks += 1;
      if (promoted && c.fact.fact_kind === "task_state") taskStateLeaks += 1;
      if (!promoted && decision?.gate === "unverified") heldUnverified += 1;

      rows.push({
        label: c.label,
        expected: c.shouldPromote,
        promoted,
        correct: promoted === c.shouldPromote,
        gate: decision?.gate,
      });
    }

    rt.close();

    const promoted = tp + fp;
    const precision = promoted > 0 ? tp / promoted : 1;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
    const pass =
      precision >= PRECISION_GATE &&
      recall >= RECALL_GATE &&
      secretLeaks === 0 &&
      taskStateLeaks === 0 &&
      heldUnverified >= 1;

    return {
      total: PROMOTION_CASES.length,
      shouldPromote: PROMOTION_CASES.filter((c) => c.shouldPromote).length,
      promoted,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      precision,
      recall,
      precisionFloor: PRECISION_GATE,
      recallFloor: RECALL_GATE,
      secretLeaks,
      taskStateLeaks,
      heldUnverified,
      pass,
      rows,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function formatPromotionReport(r: PromotionEvalReport): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval — workspace-promotion precision (M1 GATE)");
  lines.push("=".repeat(72));
  lines.push("");
  lines.push("case                                                  expect  promoted  ok");
  lines.push("-".repeat(72));
  for (const row of r.rows) {
    lines.push(
      `${row.label.slice(0, 50).padEnd(52)}${(row.expected ? "yes" : "no").padEnd(8)}${(row.promoted ? "yes" : "no").padEnd(10)}${row.correct ? "✓" : "✗"}`,
    );
  }
  lines.push("");
  lines.push("-".repeat(72));
  lines.push(
    `  precision:        ${pct(r.precision)}  (TP ${r.truePositives} / promoted ${r.promoted})`,
  );
  lines.push(
    `  recall:           ${pct(r.recall)}  (TP ${r.truePositives} / should ${r.shouldPromote})`,
  );
  lines.push(`  secret leaks:     ${r.secretLeaks}  (must be 0)`);
  lines.push(`  task_state leaks: ${r.taskStateLeaks}  (must be 0)`);
  lines.push(`  held unverified:  ${r.heldUnverified}  (must be >= 1)`);
  lines.push("");
  lines.push(
    r.pass
      ? `  VERDICT: ✅ M1 GATE PASS — precision ${pct(r.precision)} >= 90%, zero leakage; recall ${pct(r.recall)} >= 90%, probation holds.`
      : `  VERDICT: ❌ M1 GATE FAIL — precision ${pct(r.precision)}, recall ${pct(r.recall)}, leakage/probation check failed.`,
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

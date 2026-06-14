import type { ArmResult, EvalReport } from "./harness.js";

const ARM_LABEL: Record<string, string> = {
  A: "A · no memory",
  B: "B · pull-only (recall)",
  C: "C · push (graphCTX)",
};

// Renders the decisive A/B/C results table + the M0 gate verdict (SPEC §22).
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`graphCTX eval — suite: ${report.suite}`);
  lines.push("=".repeat(72));
  lines.push("");
  lines.push(
    `${
      pad("Arm", 24) + pad("Solve rate", 14) + pad("Correct cmds", 14) + pad("Repeated-fail", 14)
    }Tokens`,
  );
  lines.push("-".repeat(72));
  for (const ar of report.arms) {
    lines.push(
      pad(ARM_LABEL[ar.arm] ?? ar.arm, 24) +
        pad(`${pct(ar.postCompactSolveRate)} (${ar.needsMet}/${ar.totalNeeds})`, 14) +
        pad(String(ar.correctCommands), 14) +
        pad(String(ar.repeatedFailedCommands), 14) +
        String(ar.injectedTokens),
    );
  }
  lines.push("");

  // Per-repo breakdown.
  lines.push("Per-repo solve (needs met / total):");
  lines.push("-".repeat(72));
  const armIds = report.arms.map((a) => a.arm);
  lines.push(pad("repo", 28) + armIds.map((a) => pad(a, 12)).join(""));
  for (const r of report.perRepo) {
    const cells = armIds.map((a) => {
      const v = r.byArm[a];
      return pad(v ? `${v.needsMet}/${v.totalNeeds}` : "-", 12);
    });
    lines.push(pad(r.repo, 28) + cells.join(""));
  }
  lines.push("");

  // Integrity controls (N / S) — the defensible-evidence section.
  if (report.controls.length > 0) {
    lines.push("Integrity controls (guard against a tautological eval):");
    lines.push("-".repeat(72));
    for (const ctrl of report.controls) {
      const label =
        ctrl.arm === "N"
          ? "N · negative-control (push delivers an unfindable fact)"
          : "S · stale-fact (graphCTX suppresses an invalid fact)";
      const ok = ctrl.passed === ctrl.repos;
      lines.push(`  ${label}`);
      lines.push(
        `      ${ctrl.passed}/${ctrl.repos} repos  → ${ok ? "PASS" : "FAIL"}   (${ctrl.detail})`,
      );
    }
    lines.push("");
  }

  // M0 gate verdict.
  const b = find(report.arms, "B");
  const c = find(report.arms, "C");
  if (b && c) {
    lines.push("M0 GATE — does C (push) beat B (pull)?");
    lines.push("-".repeat(72));
    const solveBeat = c.postCompactSolveRate > b.postCompactSolveRate;
    const failBeat = c.repeatedFailedCommands < b.repeatedFailedCommands;
    lines.push(
      `  post-compaction solve rate:  C ${pct(c.postCompactSolveRate)} vs B ${pct(b.postCompactSolveRate)}  → ${solveBeat ? "PASS" : "FAIL"}`,
    );
    lines.push(
      `  repeated failed commands:    C ${c.repeatedFailedCommands} vs B ${b.repeatedFailedCommands}  → ${failBeat ? "PASS" : "FAIL"}`,
    );
    lines.push("");
    lines.push(
      solveBeat && failBeat
        ? "  VERDICT: ✅ PUSH BEATS PULL — M0 thesis validated."
        : "  VERDICT: ❌ gate not met — rethink the thesis.",
    );
    lines.push("");
    lines.push("  NOTE: the A/B/C solve gap shows push reliably DELIVERS what pull leaves to");
    lines.push("  chance. The N control is the honest headline: push supplies a fact the agent");
    lines.push("  provably cannot read from files. The S control shows we don't blindly recall.");
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function find(arms: ArmResult[], id: string): ArmResult | undefined {
  return arms.find((a) => a.arm === id);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? `${s.slice(0, n - 1)} ` : s + " ".repeat(n - s.length);
}

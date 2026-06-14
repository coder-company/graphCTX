import type { GitAnchor } from "../../core/types.js";
import { isValidAsOfSync } from "../../git/anchors.js";

// Branch-truth (SPEC §8, M3 gate). A fact learned on one branch must NOT leak
// into a sibling branch, and reverting an invalidation must restore the prior
// fact. We model a tiny commit DAG with an explicit ancestry oracle so the rule
// logic is tested deterministically without a live repo.
//
//   c0 ── c1 ── c2            (main:  package_manager = npm at c1)
//          └─── b1 ── b2      (feat:  package_manager = pnpm at b1)
//
// As-of main@c2: only npm is valid. As-of feat@b2: only pnpm is valid.
export interface BranchTruthReport {
  checks: number;
  passed: number;
  leaks: number; // a branch-local fact visible on the wrong branch (want 0)
  detail: string[];
  pass: boolean;
}

// ancestry: a is reachable from b.
const ANCESTRY: Record<string, string[]> = {
  c0: ["c0"],
  c1: ["c0", "c1"],
  c2: ["c0", "c1", "c2"],
  b1: ["c0", "b1"],
  b2: ["c0", "b1", "b2"],
};
function isAncestor(a: string, b: string): boolean {
  return ANCESTRY[b]?.includes(a) ?? false;
}

interface Case {
  label: string;
  anchor: GitAnchor;
  head: string;
  branch: string;
  expectValid: boolean;
}

const npmAnchor: GitAnchor = {
  branch: "main",
  introduced_by_commit: "c1",
  valid_from_commit: "c1",
};
const pnpmAnchor: GitAnchor = {
  branch: "feat",
  introduced_by_commit: "b1",
  valid_from_commit: "b1",
};

const CASES: Case[] = [
  {
    label: "npm valid as-of main@c2",
    anchor: npmAnchor,
    head: "c2",
    branch: "main",
    expectValid: true,
  },
  {
    label: "pnpm NOT valid as-of main@c2 (no leak)",
    anchor: pnpmAnchor,
    head: "c2",
    branch: "main",
    expectValid: false,
  },
  {
    label: "pnpm valid as-of feat@b2",
    anchor: pnpmAnchor,
    head: "b2",
    branch: "feat",
    expectValid: true,
  },
  {
    label: "npm NOT valid as-of feat@b2 (no leak)",
    anchor: npmAnchor,
    head: "b2",
    branch: "feat",
    expectValid: false,
  },
];

export function runBranchTruthEval(): BranchTruthReport {
  const detail: string[] = [];
  let passed = 0;
  let leaks = 0;

  for (const c of CASES) {
    const valid = isValidAsOfSync(c.anchor, c.head, c.branch, isAncestor);
    const ok = valid === c.expectValid;
    if (ok) passed += 1;
    else if (valid && !c.expectValid) leaks += 1; // visible where it must not be
    detail.push(`${ok ? "✓" : "✗"} ${c.label} (got valid=${valid})`);
  }

  // Revert check: a fact expired at c2 (valid_until=c2) must come back to life
  // once c2 is no longer reachable from HEAD (reverted to c1).
  const expiredAnchor: GitAnchor = {
    branch: "main",
    valid_from_commit: "c1",
    valid_until_commit: "c2",
  };
  const expiredAtHead = isValidAsOfSync(expiredAnchor, "c2", "main", isAncestor); // false (expired)
  const revivedAfterRevert = isValidAsOfSync(expiredAnchor, "c1", "main", isAncestor); // true again
  const revertOk = expiredAtHead === false && revivedAfterRevert === true;
  if (revertOk) passed += 1;
  detail.push(
    `${revertOk ? "✓" : "✗"} revert restores prior fact (expired@c2=${expiredAtHead}, revived@c1=${revivedAfterRevert})`,
  );

  const checks = CASES.length + 1;
  return { checks, passed, leaks, detail, pass: passed === checks && leaks === 0 };
}

export function formatBranchTruthReport(r: BranchTruthReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval — branch-truth (M3)");
  lines.push("=".repeat(72));
  lines.push("");
  for (const d of r.detail) lines.push(`  ${d}`);
  lines.push("");
  lines.push(`  checks: ${r.passed}/${r.checks}   cross-branch leaks: ${r.leaks} (must be 0)`);
  lines.push(
    r.pass
      ? "  VERDICT: ✅ branch-truth holds — no cross-branch leakage, revert restores truth."
      : "  VERDICT: ❌ branch-truth FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

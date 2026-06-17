import { defaultConfig } from "../../config/defaults.js";
import type { Event, InjectionContext } from "../../core/types.js";
import { type DriftSignal, type GateConfig, shouldFire } from "../../inject/gate.js";

// A single labeled gate-decision case. The inputs shape an InjectionContext (and
// optional DriftSignal) for one lifecycle moment; `shouldFire` is the LABEL — the
// decision a correct gate SHOULD make (memory plausibly helps here). The runner
// calls the REAL gate and scores precision/recall/F1 against these labels.
export interface GateCase {
  label: string;
  event: Event;
  shouldFire: boolean; // ground-truth: should memory fire here?
  user_prompt?: string;
  current_files?: string[];
  mentioned_symbols?: string[];
  planned_tool?: { name: string; args?: unknown };
  tool_result?: { success: boolean; stderr?: string; stdout_tail?: string };
  drift?: DriftSignal;
}

// Labeled benchmark spanning every gate branch, with positives AND negatives:
//   SessionStart / PostCompact — always fire (beachhead, empty space to fill).
//   UserPromptSubmit           — drift past threshold OR new entities → fire;
//                                on-topic / low-drift / no-new-entities → quiet.
//   PreToolUse                 — Bash/Edit with a concrete handle → fire;
//                                Read/WebSearch/WebFetch or arg-less Bash → quiet.
//   PostToolUse                — tool failure → fire; success → quiet.
// Drift values straddle the default threshold (0.35) on both sides.
export const GATE_CASES: GateCase[] = [
  // --- SessionStart: always fire (beachhead) ---
  {
    label: "session start (fresh)",
    event: "SessionStart",
    shouldFire: true,
    user_prompt: "start working on the auth refactor",
  },
  {
    label: "session start (resumed)",
    event: "SessionStart",
    shouldFire: true,
    user_prompt: "continue where we left off",
  },

  // --- PostCompact: always fire (recover the lost context) ---
  {
    label: "post-compact recover",
    event: "PostCompact",
    shouldFire: true,
    user_prompt: "recover the working set",
  },
  {
    label: "post-compact rehydrate",
    event: "PostCompact",
    shouldFire: true,
    user_prompt: "rehydrate open loops",
  },

  // --- UserPromptSubmit: drift above threshold → fire ---
  {
    label: "topic shift (high drift)",
    event: "UserPromptSubmit",
    shouldFire: true,
    user_prompt: "switch to the billing module now",
    drift: { centroidDistance: 0.6, hasNewEntities: false },
  },
  {
    label: "moderate drift above threshold",
    event: "UserPromptSubmit",
    shouldFire: true,
    user_prompt: "actually let's look at deployment",
    drift: { centroidDistance: 0.42, hasNewEntities: false },
  },
  {
    label: "new entities, low drift",
    event: "UserPromptSubmit",
    shouldFire: true,
    user_prompt: "open src/payments/charge.ts",
    current_files: ["src/payments/charge.ts"],
    drift: { centroidDistance: 0.1, hasNewEntities: true },
  },
  {
    label: "no drift signal, entities present (fallback)",
    event: "UserPromptSubmit",
    shouldFire: true,
    user_prompt: "review the login handler",
    current_files: ["src/auth/login.ts"],
    drift: undefined,
  },
  // --- UserPromptSubmit: on-topic continuation → quiet ---
  {
    label: "on-topic continuation, low drift",
    event: "UserPromptSubmit",
    shouldFire: false,
    user_prompt: "and the next part of the same change",
    drift: { centroidDistance: 0.1, hasNewEntities: false },
  },
  {
    label: "same topic, mild drift below threshold",
    event: "UserPromptSubmit",
    shouldFire: false,
    user_prompt: "keep going on this file",
    drift: { centroidDistance: 0.2, hasNewEntities: false },
  },
  {
    label: "drift exactly at threshold (not past it)",
    event: "UserPromptSubmit",
    shouldFire: false,
    user_prompt: "still the same area",
    drift: { centroidDistance: 0.35, hasNewEntities: false },
  },
  {
    label: "no drift signal, no entities (fallback quiet)",
    event: "UserPromptSubmit",
    shouldFire: false,
    user_prompt: "thanks, continue",
    drift: undefined,
  },

  // --- PreToolUse: memory plausibly applies → fire ---
  {
    label: "bash npm test",
    event: "PreToolUse",
    shouldFire: true,
    planned_tool: { name: "Bash", args: { command: "npm test" } },
  },
  {
    label: "bash npm run build",
    event: "PreToolUse",
    shouldFire: true,
    planned_tool: { name: "Bash", args: { command: "npm run build" } },
  },
  {
    label: "edit a real path",
    event: "PreToolUse",
    shouldFire: true,
    planned_tool: { name: "Edit", args: { file_path: "src/index.ts" } },
  },
  {
    label: "write a new file with content",
    event: "PreToolUse",
    shouldFire: true,
    planned_tool: { name: "Write", args: { file_path: "src/app.ts", content: "export {}" } },
  },
  {
    label: "create a file",
    event: "PreToolUse",
    shouldFire: true,
    planned_tool: { name: "Create", args: { file_path: "src/new.ts" } },
  },
  // --- PreToolUse: not actionable / irrelevant tool → quiet ---
  {
    label: "websearch (irrelevant tool)",
    event: "PreToolUse",
    shouldFire: false,
    planned_tool: { name: "WebSearch", args: { query: "how to center a div" } },
  },
  {
    label: "read a file (irrelevant tool)",
    event: "PreToolUse",
    shouldFire: false,
    planned_tool: { name: "Read", args: { file_path: "README.md" } },
  },
  {
    label: "webfetch a url (irrelevant tool)",
    event: "PreToolUse",
    shouldFire: false,
    planned_tool: { name: "WebFetch", args: { url: "https://example.com" } },
  },
  {
    label: "grep (irrelevant tool)",
    event: "PreToolUse",
    shouldFire: false,
    planned_tool: { name: "Grep", args: { pattern: "TODO" } },
  },
  {
    label: "bash with no args (not actionable)",
    event: "PreToolUse",
    shouldFire: false,
    planned_tool: { name: "Bash" },
  },
  {
    label: "bash echo (harmless shell)",
    event: "PreToolUse",
    shouldFire: false,
    planned_tool: { name: "Bash", args: { command: "echo ok" } },
  },
  {
    label: "bash pwd (harmless shell)",
    event: "PreToolUse",
    shouldFire: false,
    planned_tool: { name: "Bash", args: { command: "pwd" } },
  },

  // --- PostToolUse: fire only on failure (recovery hand-off) ---
  {
    label: "tool failed (build error)",
    event: "PostToolUse",
    shouldFire: true,
    tool_result: { success: false, stderr: "tsc: error TS2304" },
  },
  {
    label: "tool failed (test failure)",
    event: "PostToolUse",
    shouldFire: true,
    tool_result: { success: false, stderr: "1 test failed" },
  },
  // --- PostToolUse: success → quiet ---
  {
    label: "tool succeeded (build ok)",
    event: "PostToolUse",
    shouldFire: false,
    tool_result: { success: true },
  },
  {
    label: "tool succeeded (tests pass)",
    event: "PostToolUse",
    shouldFire: false,
    tool_result: { success: true, stdout_tail: "all tests passed" },
  },
];

// Floors are the measured baseline (precision 1.000, recall 1.000) dropped a
// notch so the suite PASSES today but flags a real regression. Recall is the
// priority signal (surface relevance != utility; maximize recall first), so both
// floors sit at 0.90 — one stray misclassification still passes, a systematic
// regression does not.
const RECALL_FLOOR = 0.9;
const PRECISION_FLOOR = 0.9;

export interface GateBranchStat {
  event: Event;
  cases: number;
  correct: number;
  falsePositives: number; // gate fired when it should not
  falseNegatives: number; // gate stayed quiet when it should fire
}

export interface GatePrecisionReport {
  cases: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  recallFloor: number;
  precisionFloor: number;
  pass: boolean;
  branches: GateBranchStat[];
  rows: Array<{
    label: string;
    event: Event;
    expected: boolean;
    actual: boolean;
    correct: boolean;
  }>;
}

// Derive the project's DEFAULT gate config so the benchmark measures what ships:
// enabled_events = [SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
// PostCompact] and gate_drift_threshold = 0.35.
function defaultGateConfig(): GateConfig {
  const c = defaultConfig().inject;
  return { enabledEvents: c.enabled_events, driftThreshold: c.gate_drift_threshold };
}

function buildContext(c: GateCase): InjectionContext {
  return {
    event: c.event,
    scope: { user_id: "eval-user", workspace_id: "eval-ws", session_id: "gate-eval" },
    git: { repo_id: "eval-ws", head: "HEAD", branch: "main" },
    user_prompt: c.user_prompt,
    current_files: c.current_files,
    mentioned_symbols: c.mentioned_symbols,
    planned_tool: c.planned_tool,
    tool_result: c.tool_result,
  };
}

// Run the REAL shouldFire() over every labeled case and score the confusion
// matrix + precision/recall/F1/accuracy. Deterministic: no clock, no I/O, fixed
// config and dataset.
export function runGatePrecisionEval(): GatePrecisionReport {
  const cfg = defaultGateConfig();
  const events: Event[] = [
    "SessionStart",
    "PostCompact",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
  ];
  const branchMap = new Map<Event, GateBranchStat>();
  for (const e of events) {
    branchMap.set(e, { event: e, cases: 0, correct: 0, falsePositives: 0, falseNegatives: 0 });
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const rows: GatePrecisionReport["rows"] = [];

  for (const c of GATE_CASES) {
    const actual = shouldFire(buildContext(c), cfg, c.drift);
    const expected = c.shouldFire;
    const correct = actual === expected;
    if (expected && actual) tp += 1;
    else if (!expected && actual) fp += 1;
    else if (expected && !actual) fn += 1;
    else tn += 1;

    const stat = branchMap.get(c.event);
    if (stat) {
      stat.cases += 1;
      if (correct) stat.correct += 1;
      else if (actual && !expected) stat.falsePositives += 1;
      else if (!actual && expected) stat.falseNegatives += 1;
    }

    rows.push({ label: c.label, event: c.event, expected, actual, correct });
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = GATE_CASES.length > 0 ? (tp + tn) / GATE_CASES.length : 0;

  return {
    cases: GATE_CASES.length,
    tp,
    fp,
    fn,
    tn,
    precision,
    recall,
    f1,
    accuracy,
    recallFloor: RECALL_FLOOR,
    precisionFloor: PRECISION_FLOOR,
    pass: recall >= RECALL_FLOOR && precision >= PRECISION_FLOOR,
    branches: events.map((e) => branchMap.get(e)!),
    rows,
  };
}

export function formatGatePrecisionReport(r: GatePrecisionReport): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const num = (n: number) => n.toFixed(3);
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval — gate precision/recall (firing-decision accuracy)");
  lines.push("=".repeat(72));
  lines.push("");
  lines.push("case                                            event            want got ok");
  lines.push("-".repeat(72));
  for (const row of r.rows) {
    lines.push(
      `${row.label.slice(0, 44).padEnd(46)}${row.event.padEnd(17)}${(row.expected ? "fire" : "hold").padEnd(5)}${(row.actual ? "fire" : "hold").padEnd(4)}${row.correct ? "✓" : "✗"}`,
    );
  }
  lines.push("");
  lines.push("per-branch (cases | correct | false-pos | false-neg)");
  lines.push("-".repeat(72));
  for (const b of r.branches) {
    lines.push(
      `  ${b.event.padEnd(18)}${String(b.cases).padEnd(8)}${String(b.correct).padEnd(10)}${String(b.falsePositives).padEnd(11)}${b.falseNegatives}`,
    );
  }
  lines.push("");
  lines.push("-".repeat(72));
  lines.push(`  cases:          ${r.cases}`);
  lines.push(`  confusion:      TP ${r.tp}  FP ${r.fp}  FN ${r.fn}  TN ${r.tn}`);
  lines.push(
    `  precision:      ${num(r.precision)}  (${pct(r.precision)})  floor ${num(r.precisionFloor)}`,
  );
  lines.push(`  recall:         ${num(r.recall)}  (${pct(r.recall)})  floor ${num(r.recallFloor)}`);
  lines.push(`  F1:             ${num(r.f1)}`);
  lines.push(`  accuracy:       ${num(r.accuracy)}  (${pct(r.accuracy)})`);
  lines.push("");
  lines.push(
    r.pass
      ? `  VERDICT: ✅ GATE PRECISION PASS — recall ${num(r.recall)} >= ${num(r.recallFloor)}, precision ${num(r.precision)} >= ${num(r.precisionFloor)}.`
      : `  VERDICT: ❌ GATE PRECISION FAIL — recall ${num(r.recall)} (floor ${num(r.recallFloor)}), precision ${num(r.precision)} (floor ${num(r.precisionFloor)}).`,
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

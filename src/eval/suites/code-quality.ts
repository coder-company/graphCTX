import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_COMMANDS, EXPECTED_COMMAND_SET, commandsFromHelp } from "../command-surface.js";
import { EVAL_GATE_SUITES, type EvalGateSuite } from "../registry.js";

// Final code-quality gate. This keeps the cheap deterministic checks close to
// the product: full-repo lint/format, strict TS config, dead CLI/eval surface
// drift, and README setup/test accuracy. The expensive gates (tsc/vitest/metric)
// remain exact top-level validation commands to avoid recursive test execution.

export interface CodeQualityReport {
  checks: number;
  passed: number;
  detail: string[];
  fullBiomeExit: number;
  commandCount: number;
  evalSuiteCount: number;
  coveredEvalSuites: number;
  staleDocCommands: string[];
  staleReadmeCommands: string[];
  unexpectedCommands: string[];
  pass: boolean;
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

const DOC_COMMAND_SURFACE_FILES = [
  "README.md",
  "DEMO.md",
  "docs/SPEC.md",
  "docs/STATUS.md",
  "docs/PRD.md",
  "docs/GAMEPLAN.md",
] as const;

const STALE_DOC_PATTERNS = [
  { label: "graphctx inject", re: /graphctx inject\b/ },
  { label: "graphctx time-travel", re: /graphctx time-travel\b/ },
  { label: "graphctx why fact", re: /graphctx why fact\b/ },
  { label: "graphctx profile", re: /graphctx profile\b/ },
  { label: "graphctx conflicts", re: /graphctx conflicts\b/ },
  { label: "graphctx checkpoint", re: /graphctx checkpoint\b/ },
  { label: "CLI time-travel", re: /CLI[^\n]*time-travel/ },
] as const;

const EXPECTED_EVAL_TESTS: Record<EvalGateSuite, string> = {
  run: "test/eval/harness.test.ts",
  memory: "test/eval/core-memory-lifecycle.test.ts",
  promote: "test/promote/promotion-eval.test.ts",
  drift: "test/eval/drift-gate.test.ts",
  retrieval: "test/eval/retrieval-quality.test.ts",
  gate: "test/eval/gate-precision.test.ts",
  security: "test/eval/security-adversarial.test.ts",
  branch: "test/eval/m3-suites.test.ts",
  temporal: "test/eval/temporal-correctness.test.ts",
  conflict: "test/eval/parallel-conflict.test.ts",
  procedure: "test/eval/m3-suites.test.ts",
  mcp: "test/eval/adapters-mcp.test.ts",
  storage: "test/eval/storage-migrations.test.ts",
  telemetry: "test/eval/telemetry-learning.test.ts",
  provenance: "test/eval/provenance-why.test.ts",
  resilience: "test/eval/resilience-failsoft.test.ts",
  benchmarks: "test/eval/eval-benchmarks.test.ts",
  "cli-docs-demo": "test/eval/cli-docs-demo.test.ts",
  quality: "test/eval/code-quality.test.ts",
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const tsxBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const biomeBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "biome.cmd" : "biome",
);

export function runCodeQualityEval(): CodeQualityReport {
  const detail: string[] = [];
  let passed = 0;

  const check = (name: string, ok: boolean, note?: string) => {
    if (ok) passed += 1;
    detail.push(`${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
  };

  const fullBiome = command(biomeBin, ["check", "."]);
  check(
    "full-repo Biome check has zero lint/format debt",
    fullBiome.status === 0,
    fullBiome.status === 0 ? "EXIT=0" : firstDiagnostic(fullBiome),
  );

  const tsconfig = JSON.parse(readRepo("tsconfig.json")) as {
    compilerOptions?: Record<string, unknown>;
  };
  const packageJson = JSON.parse(readRepo("package.json")) as {
    scripts?: Record<string, string>;
  };
  const compiler = tsconfig.compilerOptions ?? {};
  const scripts = packageJson.scripts ?? {};
  check(
    "strict TypeScript and required local quality scripts are configured",
    compiler.strict === true &&
      compiler.noUncheckedIndexedAccess === true &&
      compiler.noImplicitOverride === true &&
      compiler.noFallthroughCasesInSwitch === true &&
      scripts.typecheck === "tsc --noEmit" &&
      scripts.lint === "biome check src test" &&
      scripts.test === "vitest run" &&
      scripts.bench === "tsx src/cli.ts bench" &&
      scripts.eval === "tsx src/cli.ts eval run",
    `strict=${String(compiler.strict)} noUnchecked=${String(compiler.noUncheckedIndexedAccess)} scripts=${Object.keys(
      scripts,
    )
      .filter((s) => ["typecheck", "lint", "test", "bench", "eval"].includes(s))
      .join(",")}`,
  );

  const help = command(tsxBin, [cliPath, "--help"]);
  const helpCommands = commandsFromHelp(help.stdout);
  const statusRow = tableRow(readRepo("docs/STATUS.md"), "cli.ts");
  const readme = readRepo("README.md");
  const launchDocs = readLaunchDocs();
  const missingHelp = EXPECTED_COMMANDS.filter((cmd) => !helpCommands.includes(cmd));
  const unexpectedCommands = helpCommands.filter((cmd) => !EXPECTED_COMMAND_SET.has(cmd));
  const missingStatus = EXPECTED_COMMANDS.filter((cmd) => !statusRow.includes(cmd));
  const missingReadme = EXPECTED_COMMANDS.filter((cmd) => !readme.includes(`graphctx ${cmd}`));
  const staleDocCommands = staleCommandsInDocs(launchDocs);
  check(
    "CLI command surface is documented, reachable, and free of stale launch-doc commands",
    help.status === 0 &&
      missingHelp.length === 0 &&
      unexpectedCommands.length === 0 &&
      missingStatus.length === 0 &&
      missingReadme.length === 0 &&
      staleDocCommands.length === 0,
    `missingHelp=${missingHelp.join(",") || "-"} unexpected=${unexpectedCommands.join(",") || "-"} missingStatus=${missingStatus.join(",") || "-"} missingReadme=${missingReadme.join(",") || "-"} stale=${staleDocCommands.join(",") || "-"}`,
  );

  const cliSource = readRepo("src/cli.ts");
  const missingRunners = EVAL_GATE_SUITES.filter((suite) => !hasEvalRunner(cliSource, suite));
  const missingEvalTests = EVAL_GATE_SUITES.filter((suite) => {
    const path = EXPECTED_EVAL_TESTS[suite];
    return !path || !existsSync(join(repoRoot, path));
  });
  check(
    "eval registry has CLI runners and Vitest coverage for every suite",
    missingRunners.length === 0 && missingEvalTests.length === 0,
    `suites=${EVAL_GATE_SUITES.length} missingRunners=${missingRunners.join(",") || "-"} missingTests=${missingEvalTests.join(",") || "-"}`,
  );

  const docs = readRepo("README.md");
  check(
    "README is final-state docs-as-code: setup, run, test, and quality commands are current",
    docs.includes("npm install") &&
      docs.includes("npx tsx src/cli.ts --help") &&
      docs.includes("npx tsx src/cli.ts eval all") &&
      docs.includes("npx vitest run") &&
      docs.includes("npx tsc --noEmit") &&
      docs.includes("npx biome check src test") &&
      docs.includes("npx tsx src/cli.ts bench") &&
      !/Pre-MVP|Planned interface/.test(docs),
    "requires setup/run/test instructions and no stale pre-MVP framing",
  );

  const generatedMigration = "src/store/migrations.generated.ts";
  const generatedMigrationIgnored = command("git", ["check-ignore", generatedMigration]);
  check(
    "generated migration import target exists and is not gitignored",
    existsSync(join(repoRoot, generatedMigration)) && generatedMigrationIgnored.status !== 0,
    `exists=${String(existsSync(join(repoRoot, generatedMigration)))} gitignored=${String(
      generatedMigrationIgnored.status === 0,
    )}`,
  );

  const checks = detail.length;
  const coveredEvalSuites = EVAL_GATE_SUITES.filter((suite) =>
    existsSync(join(repoRoot, EXPECTED_EVAL_TESTS[suite])),
  ).length;
  const pass = passed === checks && fullBiome.status === 0;
  return {
    checks,
    passed,
    detail,
    fullBiomeExit: fullBiome.status,
    commandCount: helpCommands.length,
    evalSuiteCount: EVAL_GATE_SUITES.length,
    coveredEvalSuites,
    staleDocCommands,
    staleReadmeCommands: staleDocCommands,
    unexpectedCommands,
    pass,
  };
}

export function formatCodeQualityReport(r: CodeQualityReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval - code quality");
  lines.push("=".repeat(72));
  lines.push("");
  for (const d of r.detail) lines.push(`  ${d}`);
  lines.push("");
  lines.push(
    `  checks: ${r.passed}/${r.checks}   full biome exit: ${r.fullBiomeExit}   commands: ${r.commandCount}   unexpected commands: ${r.unexpectedCommands.length}`,
  );
  lines.push(
    `  eval suites: ${r.evalSuiteCount}   covered suites: ${r.coveredEvalSuites}   stale doc commands: ${r.staleDocCommands.length}`,
  );
  lines.push(
    r.pass
      ? "  VERDICT: ✅ CODE QUALITY PASS - lint, docs, command reachability, and suite coverage are locked."
      : "  VERDICT: ❌ CODE QUALITY FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function command(file: string, args: string[]): CommandResult {
  try {
    const stdout = execFileSync(file, args, {
      cwd: repoRoot,
      env: { ...process.env, GRAPHCTX_USER_ID: "quality-eval" },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: err.status ?? 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
    };
  }
}

function tableRow(markdown: string, cell: string): string {
  return (
    markdown
      .split("\n")
      .find((line) => line.startsWith("|") && line.includes(`| ${cell} |`))
      ?.trim() ?? ""
  );
}

function hasEvalRunner(cliSource: string, suite: EvalGateSuite): boolean {
  if (suite.includes("-")) return cliSource.includes(`${JSON.stringify(suite)}:`);
  return new RegExp(`\\b${suite}:`).test(cliSource);
}

function readRepo(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function readLaunchDocs(): Array<{ path: string; text: string }> {
  return DOC_COMMAND_SURFACE_FILES.map((path) => ({ path, text: readRepo(path) }));
}

function staleCommandsInDocs(docs: Array<{ path: string; text: string }>): string[] {
  const hits: string[] = [];
  for (const doc of docs) {
    for (const pattern of STALE_DOC_PATTERNS) {
      if (pattern.re.test(doc.text)) hits.push(`${doc.path}:${pattern.label}`);
    }
  }
  return hits;
}

function firstDiagnostic(result: CommandResult): string {
  for (const output of [result.stderr, result.stdout]) {
    const line = output
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0);
    if (line) return line;
  }
  return `EXIT=${result.status}`;
}

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_DEPLOY_CMD, setupDemo } from "../../adapters/claude-code/demo.js";
import { defaultConfig } from "../../config/defaults.js";
import { McpServer } from "../../mcp/server.js";
import { MCP_TOOLS } from "../../mcp/tools.js";
import { EVAL_GATE_SUITES } from "../registry.js";

// CLI/docs/demo parity gate. This suite protects the human/agent-facing surface:
// help discovery, doc/spec drift, reproducible offline demo, actionable doctor
// output, exact MCP tool advertisement, and install/uninstall UX.

export interface CliDocsDemoReport {
  checks: number;
  passed: number;
  detail: string[];
  commandCount: number;
  testCount: number;
  suiteCount: number;
  demoFacts: number;
  mcpTools: number;
  networkCalls: number;
  pipeFailures: number;
  pass: boolean;
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

const EXPECTED_COMMANDS = [
  "init",
  "install",
  "uninstall",
  "hook",
  "recall",
  "remember",
  "loop",
  "resolve",
  "extract",
  "serve",
  "why",
  "doctor",
  "demo",
  "tui",
  "compare",
  "bench",
  "eval",
] as const;

const EXPECTED_ENABLED_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostCompact",
];

const EXPECTED_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
];

const EXPECTED_MCP_TOOLS = [
  "remember",
  "recall",
  "inject_context",
  "checkpoint_session",
  "promote",
  "forget",
  "why",
  "resolve_conflict",
];

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const tsxBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const vitestBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vitest.cmd" : "vitest",
);
const fixtureRepo = join(repoRoot, "fixtures", "repo-pnpm-web");

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "graphctx eval",
  GIT_AUTHOR_EMAIL: "eval@graphctx.local",
  GIT_COMMITTER_NAME: "graphctx eval",
  GIT_COMMITTER_EMAIL: "eval@graphctx.local",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00 +0000",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00 +0000",
};

export async function runCliDocsDemoEval(): Promise<CliDocsDemoReport> {
  const detail: string[] = [];
  let passed = 0;
  let pipeFailures = 0;

  const check = (name: string, ok: boolean, note?: string) => {
    if (ok) passed += 1;
    detail.push(`${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
  };

  const help = cli(["--help"]);
  const helpCommands = commandsFromHelp(help.stdout);
  const status = readRepo("docs/STATUS.md");
  const spec = readRepo("docs/SPEC.md");
  const demoDoc = readRepo("DEMO.md");
  const statusCliRow = tableRow(status, "cli.ts");
  const specCliBlock = sectionCodeBlock(spec, "## 19. CLI");
  const missingHelp = EXPECTED_COMMANDS.filter((cmd) => !helpCommands.includes(cmd));
  const missingStatus = EXPECTED_COMMANDS.filter((cmd) => !statusCliRow.includes(cmd));
  const missingSpec = EXPECTED_COMMANDS.filter((cmd) => !specCliBlock.includes(`graphctx ${cmd}`));
  check(
    "every documented command is exposed by --help and STATUS/SPEC list no stale surface",
    help.status === 0 &&
      missingHelp.length === 0 &&
      missingStatus.length === 0 &&
      missingSpec.length === 0 &&
      !/\b(inject|checkpoint|profile|conflicts|time-travel)\b/.test(specCliBlock),
    `help=${helpCommands.length} missingHelp=${missingHelp.join(",") || "-"} missingStatus=${missingStatus.join(",") || "-"} missingSpec=${missingSpec.join(",") || "-"}`,
  );

  const defaultEvents = defaultConfig().inject.enabled_events;
  const specEvents = parseQuotedArrayAssignment(spec, "enabled_events");
  const gateSource = readRepo("src/inject/gate.ts");
  check(
    "SPEC enabled_events matches shipped defaults and includes PostToolUse",
    sameList(defaultEvents, EXPECTED_ENABLED_EVENTS) &&
      sameList(specEvents, EXPECTED_ENABLED_EVENTS) &&
      gateSource.includes('case "PostToolUse"'),
    `SPEC=${specEvents.join(",")} defaults=${defaultEvents.join(",")}`,
  );

  const hookSource = readRepo("src/adapters/claude-code/install.ts");
  const sourceHookEvents = parseConstArray(hookSource, "HOOK_EVENTS");
  const specHookEvents = parseParenListAfter(spec, "`install.ts` writes hook entries");
  check(
    "SPEC claude-code wired hook events match install.ts HOOK_EVENTS",
    sameList(sourceHookEvents, EXPECTED_HOOK_EVENTS) &&
      sameList(specHookEvents, EXPECTED_HOOK_EVENTS),
    `SPEC=${specHookEvents.join(",")} source=${sourceHookEvents.join(",")}`,
  );

  const testCount = vitestListCount();
  const statusTestCount = Number(status.match(/Tests:\s*(\d+)/)?.[1] ?? 0);
  const statusSuiteCount = Number(status.match(/Gate suites:\s*(\d+)/)?.[1] ?? 0);
  const demoSuiteCount = Number(demoDoc.match(/graphctx eval all\s+#\s+(\d+) suites/)?.[1] ?? 0);
  check(
    "STATUS and DEMO counters match live test/suite totals",
    statusTestCount === testCount &&
      statusSuiteCount === EVAL_GATE_SUITES.length &&
      demoSuiteCount === EVAL_GATE_SUITES.length &&
      status.includes("cli-docs-demo") &&
      demoDoc.includes("cli-docs-demo"),
    `tests ${statusTestCount}/${testCount}; suites STATUS=${statusSuiteCount} DEMO=${demoSuiteCount} live=${EVAL_GATE_SUITES.length}`,
  );

  const demo = await evaluateDemo();
  check(
    "demo is offline, memory-only, reproducible, and prints the two-step script",
    demo.cli.status === 0 &&
      demo.facts > 0 &&
      demo.cli.stdout.includes("graphctx demo — ready ✅  (offline, no network)") &&
      demo.cli.stdout.includes("STEP 1") &&
      demo.cli.stdout.includes("STEP 2") &&
      demo.cli.stdout.includes("facts in memory:") &&
      demo.agentsRemoved &&
      demo.deployCommandAbsentFromFiles &&
      demo.networkCalls === 0,
    `facts=${demo.facts} absent=${demo.deployCommandAbsentFromFiles} networkCalls=${demo.networkCalls}`,
  );

  const doctor = evaluateDoctor();
  check(
    "doctor gives READY/NOT READY verdicts with remediation",
    doctor.notReady.status === 0 &&
      doctor.ready.status === 0 &&
      doctor.notReady.stdout.includes("NOT READY") &&
      /graphctx (install|extract)/.test(doctor.notReady.stdout) &&
      doctor.ready.stdout.includes("READY") &&
      doctor.ready.stdout.includes("push is live") &&
      doctor.afterUninstall.stdout.includes("NOT READY") &&
      doctor.afterUninstall.stdout.includes("claude hooks: not installed"),
    `notReady=${lastNonEmptyLine(doctor.notReady.stdout)} ready=${lastNonEmptyLine(doctor.ready.stdout)} afterUninstall=${lastNonEmptyLine(doctor.afterUninstall.stdout)}`,
  );

  const mcp = await evaluateMcpTools();
  check(
    "serve --mcp advertises exactly the documented 8 tools",
    mcp.status === 0 && sameList(mcp.names, EXPECTED_MCP_TOOLS) && MCP_TOOLS.length === 8,
    `got ${mcp.names.length}: ${mcp.names.join(", ")}`,
  );

  const install = evaluateInstallRoundTrip();
  check(
    "install claude / uninstall claude round-trip writes then removes hook config",
    install.installed.status === 0 &&
      install.uninstalled.status === 0 &&
      install.settingsPresent &&
      install.hooksAfterInstall > 0 &&
      install.hooksAfterUninstall === 0,
    `settings=${install.settingsPresent} hooks=${install.hooksAfterInstall}->${install.hooksAfterUninstall}`,
  );

  const auto = evaluateInstallAutoAndUnknown();
  if (/EPIPE|write EPIPE|Unhandled|stack|Trace/.test(auto.auto.stderr)) pipeFailures += 1;
  check(
    "install auto pipes cleanly and install <unknown> errors with supported clients",
    auto.auto.status === 0 &&
      auto.auto.stdout.trim() === "auto-detected client: generic" &&
      !/EPIPE|write EPIPE|Unhandled|stack|Trace/.test(auto.auto.stderr) &&
      auto.unknown.status === 1 &&
      auto.unknown.stderr.includes('unknown client "frobnicate"') &&
      auto.unknown.stderr.includes("supported: claude, cursor, opencode, generic, auto"),
    `auto=${JSON.stringify(auto.auto.stdout.trim())} unknownExit=${auto.unknown.status}`,
  );

  const checks = detail.length;
  const report: CliDocsDemoReport = {
    checks,
    passed,
    detail,
    commandCount: helpCommands.length,
    testCount,
    suiteCount: EVAL_GATE_SUITES.length,
    demoFacts: demo.facts,
    mcpTools: mcp.names.length,
    networkCalls: demo.networkCalls,
    pipeFailures,
    pass: passed === checks && demo.networkCalls === 0 && pipeFailures === 0,
  };
  return report;
}

export function formatCliDocsDemoReport(r: CliDocsDemoReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval - CLI/docs/demo parity");
  lines.push("=".repeat(72));
  lines.push("");
  for (const d of r.detail) lines.push(`  ${d}`);
  lines.push("");
  lines.push(
    `  checks: ${r.passed}/${r.checks}   commands: ${r.commandCount}   tests: ${r.testCount}   suites: ${r.suiteCount}`,
  );
  lines.push(
    `  demo facts: ${r.demoFacts}   MCP tools: ${r.mcpTools}   network calls: ${r.networkCalls}   pipe failures: ${r.pipeFailures}`,
  );
  lines.push(
    r.pass
      ? "  VERDICT: ✅ CLI DOCS DEMO PASS - help, docs, demo, doctor, MCP, and install UX stay aligned."
      : "  VERDICT: ❌ CLI DOCS DEMO FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function cli(args: string[], input?: string, env: NodeJS.ProcessEnv = process.env): CliResult {
  try {
    const stdout = execFileSync(tsxBin, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...env, GRAPHCTX_USER_ID: "cli-docs-demo-eval" },
      input,
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

function shell(script: string, env: NodeJS.ProcessEnv = process.env): CliResult {
  try {
    const stdout = execFileSync("bash", ["-lc", script], {
      cwd: repoRoot,
      env: { ...env, GRAPHCTX_USER_ID: "cli-docs-demo-eval" },
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

function commandsFromHelp(help: string): string[] {
  const commands = new Set<string>();
  for (const line of help.split("\n")) {
    const m = line.match(/^\s{2}([a-z][a-z-]*)\b/);
    if (m?.[1] && m[1] !== "help") commands.add(m[1]);
  }
  return [...commands];
}

function parseQuotedArrayAssignment(text: string, key: string): string[] {
  const m = text.match(new RegExp(`["']?${key}["']?\\s*[:=]\\s*\\[([^\\]]*)\\]`));
  return m?.[1] ? quotedStrings(m[1]) : [];
}

function parseConstArray(text: string, name: string): string[] {
  const m = text.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s+as const`));
  return m?.[1] ? quotedStrings(m[1]) : [];
}

function parseParenListAfter(text: string, marker: string): string[] {
  const i = text.indexOf(marker);
  if (i < 0) return [];
  const after = text.slice(i);
  const m = after.match(/\(([^)]*)\)/);
  return m?.[1] ? quotedStrings(m[1]) : [];
}

function quotedStrings(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`|"([^"]+)"/g)].map((m) => m[1] ?? m[2] ?? "");
}

function sectionCodeBlock(text: string, heading: string): string {
  const i = text.indexOf(heading);
  if (i < 0) return "";
  const after = text.slice(i);
  const m = after.match(/```(?:[a-z]*)?\n([\s\S]*?)```/);
  return m?.[1] ?? "";
}

function tableRow(markdown: string, cell: string): string {
  return (
    markdown
      .split("\n")
      .find((line) => line.startsWith("|") && line.includes(`| ${cell} |`))
      ?.trim() ?? ""
  );
}

function vitestListCount(): number {
  const stdout = execFileSync(vitestBin, ["list"], {
    cwd: repoRoot,
    env: { ...process.env, GRAPHCTX_USER_ID: "cli-docs-demo-eval" },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.split("\n").filter((line) => line.startsWith("test/")).length;
}

async function evaluateDemo(): Promise<{
  cli: CliResult;
  facts: number;
  agentsRemoved: boolean;
  deployCommandAbsentFromFiles: boolean;
  networkCalls: number;
}> {
  const offline = await withTempDirAsync("graphctx-cli-demo-offline-", async (parent) => {
    const dir = join(parent, "demo");
    return withOfflineNetworkTrap(async () => setupDemo(dir));
  });

  return withTempDir("graphctx-cli-demo-", (parent) => {
    const dir = join(parent, "demo");
    const out = cli(["demo", "--dir", dir]);
    const facts = Number(out.stdout.match(/facts in memory:\s+(\d+)/)?.[1] ?? 0);
    return {
      cli: out,
      facts,
      agentsRemoved: !existsSync(join(dir, "AGENTS.md")),
      deployCommandAbsentFromFiles: !repoFilesContain(dir, DEMO_DEPLOY_CMD),
      networkCalls: offline.networkCalls,
    };
  });
}

function evaluateDoctor(): {
  notReady: CliResult;
  ready: CliResult;
  afterUninstall: CliResult;
} {
  const notReady = withFixtureRepo((dir) => cli(["doctor", "-C", dir]));
  const ready = withFixtureRepo((dir) => {
    initGitRepo(dir);
    cli(["install", "claude", "-C", dir]);
    return cli(["doctor", "-C", dir]);
  });
  const afterUninstall = withFixtureRepo((dir) => {
    initGitRepo(dir);
    cli(["init", "-C", dir]);
    cli(["install", "claude", "-C", dir]);
    cli(["uninstall", "claude", "-C", dir]);
    return cli(["doctor", "-C", dir]);
  });
  return { notReady, ready, afterUninstall };
}

async function evaluateMcpTools(): Promise<{ status: number; names: string[] }> {
  return withTempDirAsync("graphctx-cli-mcp-", async (dir) => {
    const server = new McpServer({ workspaceDir: dir, userId: "cli-docs-demo-eval" });
    try {
      const res = (await server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      })) as { result?: { tools?: Array<{ name?: string }> } };
      return { status: 0, names: res.result?.tools?.map((t) => t.name ?? "") ?? [] };
    } finally {
      server.close();
    }
  });
}

function evaluateInstallRoundTrip(): {
  installed: CliResult;
  uninstalled: CliResult;
  settingsPresent: boolean;
  hooksAfterInstall: number;
  hooksAfterUninstall: number;
} {
  return withTempDir("graphctx-cli-install-", (dir) => {
    initGitRepo(dir);
    const installed = cli(["install", "claude", "-C", dir]);
    const settingsPath = join(dir, ".claude", "settings.json");
    const installedText = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";
    const uninstalled = cli(["uninstall", "claude", "-C", dir]);
    const uninstalledText = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";
    return {
      installed,
      uninstalled,
      settingsPresent: existsSync(settingsPath),
      hooksAfterInstall: countMatches(installedText, /hook (SessionStart|PostCompact|SessionEnd)/g),
      hooksAfterUninstall: countMatches(
        uninstalledText,
        /hook (SessionStart|PostCompact|SessionEnd)/g,
      ),
    };
  });
}

function evaluateInstallAutoAndUnknown(): { auto: CliResult; unknown: CliResult } {
  return withTempDir("graphctx-cli-auto-", (dir) => {
    initGitRepo(dir);
    const auto = shell(
      `${shQuote(tsxBin)} ${shQuote(cliPath)} install auto -C ${shQuote(dir)} | head -1`,
    );
    const unknown = cli(["install", "frobnicate", "-C", dir]);
    return { auto, unknown };
  });
}

async function withOfflineNetworkTrap<T>(fn: () => Promise<T>): Promise<{
  value: T;
  networkCalls: number;
}> {
  const holder = globalThis as unknown as { fetch?: (...args: unknown[]) => Promise<unknown> };
  const originalFetch = holder.fetch;
  let networkCalls = 0;
  holder.fetch = async () => {
    networkCalls += 1;
    throw new Error("network disabled in cli-docs-demo eval");
  };
  try {
    const value = await fn();
    return { value, networkCalls };
  } finally {
    if (originalFetch) holder.fetch = originalFetch;
    else Reflect.deleteProperty(holder, "fetch");
  }
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "."], {
    cwd: dir,
    env: GIT_ENV,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "-A"], { cwd: dir, env: GIT_ENV, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"],
    {
      cwd: dir,
      env: GIT_ENV,
      stdio: "ignore",
    },
  );
}

function withFixtureRepo<T>(fn: (dir: string) => T): T {
  return withTempDir("graphctx-cli-fixture-", (dir) => {
    const work = join(dir, "repo");
    cpSync(fixtureRepo, work, { recursive: true });
    return fn(work);
  });
}

function withTempDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function repoFilesContain(root: string, needle: string): boolean {
  const skip = new Set([".graphctx", ".claude", ".git", "node_modules"]);
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        if (walk(path)) return true;
      } else if (stat.isFile()) {
        try {
          if (readFileSync(path, "utf8").includes(needle)) return true;
        } catch {
          // binary/unreadable file: irrelevant to the text negative control
        }
      }
    }
    return false;
  };
  return walk(root);
}

function readRepo(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

function shQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function lastNonEmptyLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

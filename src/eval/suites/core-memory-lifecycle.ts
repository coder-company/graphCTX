import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Core-memory lifecycle gate. This suite intentionally drives the REAL CLI
// entry point over throwaway repos: remember -> recall -> why, plus the open
// loop -> PostCompact -> resolve flow. That keeps the central memory contract
// protected at the same surface users and hooks exercise.

export interface CoreMemoryLifecycleReport {
  checks: number;
  passed: number;
  detail: string[];
  cliFailures: number;
  openLoopLeaksAfterResolve: number;
  pass: boolean;
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const tsxBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "graphctx eval",
  GIT_AUTHOR_EMAIL: "eval@graphctx.local",
  GIT_COMMITTER_NAME: "graphctx eval",
  GIT_COMMITTER_EMAIL: "eval@graphctx.local",
  GIT_AUTHOR_DATE: "2025-01-01T00:00:00 +0000",
  GIT_COMMITTER_DATE: "2025-01-01T00:00:00 +0000",
};

function cli(args: string[], input?: string): CliResult {
  try {
    const stdout = execFileSync(tsxBin, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, GRAPHCTX_USER_ID: "core-memory-eval" },
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
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

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    env: GIT_ENV,
    stdio: "ignore",
  });
}

function initRepo(dir: string, commit = false): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "."], {
    cwd: dir,
    env: GIT_ENV,
    stdio: "ignore",
  });
  if (commit) git(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
}

function withRepo<T>(fn: (dir: string) => T, commit = false): T {
  const dir = mkdtempSync(join(tmpdir(), "graphctx-memory-"));
  try {
    initRepo(dir, commit);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function runCoreMemoryLifecycleEval(): CoreMemoryLifecycleReport {
  const detail: string[] = [];
  let passed = 0;
  let cliFailures = 0;
  let openLoopLeaksAfterResolve = 0;

  const check = (name: string, ok: boolean, note?: string) => {
    if (ok) passed += 1;
    detail.push(`${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
  };

  const remember = withRepo((dir) => cli(["remember", "deploy with ./scripts/ship.sh", "-C", dir]));
  if (remember.status !== 0) cliFailures += 1;
  check(
    "remember stores a user-asserted high-trust workspace fact",
    remember.status === 0 &&
      /Remembered fact_[A-Z0-9]+: - repo note: deploy with \.\/scripts\/ship\.sh \[mem:[A-Z0-9]+\]/.test(
        remember.stdout,
      ),
    remember.stdout.trim(),
  );

  const recall = withRepo((dir) => {
    cli(["remember", "deploy with ./scripts/ship.sh", "-C", dir]);
    return cli(["recall", "how do I deploy this project", "-C", dir]);
  });
  if (recall.status !== 0) cliFailures += 1;
  check(
    "recall retrieves a just-remembered fact",
    recall.status === 0 &&
      recall.stdout.includes("deploy with ./scripts/ship.sh") &&
      /\(score [0-9.]+\)/.test(recall.stdout),
    recall.stdout.trim(),
  );

  const bootRefresh = withRepo((dir) => {
    const init = cli(["init", "-C", dir]);
    const remembered = cli([
      "remember",
      "post-install hidden command: POST_INSTALL_DOGFOOD_SENTINEL_6_GRAPHCTX",
      "-C",
      dir,
    ]);
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    return { init, remembered, agents };
  }, true);
  if (bootRefresh.init.status !== 0 || bootRefresh.remembered.status !== 0) {
    cliFailures += 1;
  }
  check(
    "remember refreshes AGENTS.md boot grounding after initial install/init",
    bootRefresh.init.status === 0 &&
      bootRefresh.remembered.status === 0 &&
      bootRefresh.agents.includes("POST_INSTALL_DOGFOOD_SENTINEL_6_GRAPHCTX"),
    bootRefresh.agents.includes("POST_INSTALL_DOGFOOD_SENTINEL_6_GRAPHCTX")
      ? "post-install memory present in AGENTS.md"
      : "post-install memory missing from AGENTS.md",
  );

  const noMatch = withRepo((dir) => cli(["recall", "anything at all", "-C", dir]));
  if (noMatch.status !== 0) cliFailures += 1;
  check(
    "recall on an empty store exits 0 with no-match UX",
    noMatch.status === 0 && noMatch.stdout.trim() === "(no matching memory)",
    `status=${noMatch.status} stdout=${JSON.stringify(noMatch.stdout.trim())}`,
  );

  const why = withRepo((dir) => {
    const out = cli([
      "remember",
      "the build uses turbo",
      "--subject",
      "build",
      "--predicate",
      "tool",
      "-C",
      dir,
    ]);
    const id = out.stdout.match(/mem:([A-Z0-9]+)/)?.[1] ?? "";
    return cli(["why", id, "-C", dir]);
  });
  if (why.status !== 0) cliFailures += 1;
  check(
    "remember -> why returns complete provenance",
    why.status === 0 &&
      why.stdout.includes("asserted by:   user") &&
      why.stdout.includes('raw quote:     "user said: the build uses turbo"') &&
      why.stdout.includes("provenance chain:") &&
      why.stdout.includes("complete"),
    compactWhy(why.stdout),
  );

  const loop = withRepo((dir) => {
    const out = cli(["loop", "finish the retry backoff", "-C", dir]);
    const id = out.stdout.match(/Open loop ([A-Z0-9]+):/)?.[1] ?? "";
    const payload = JSON.stringify({ session_id: "default-session", cwd: dir });
    const before = cli(["hook", "PostCompact", "-C", dir], payload);
    const resolved = cli(["resolve", id, "-C", dir]);
    const after = cli(["hook", "PostCompact", "-C", dir], payload);
    return { out, id, before, resolved, after };
  }, true);
  if (loop.out.status !== 0 || loop.before.status !== 0 || loop.resolved.status !== 0) {
    cliFailures += 1;
  }
  if (loop.after.stdout.includes("finish the retry backoff")) openLoopLeaksAfterResolve += 1;
  check(
    "open loop resurfaces at PostCompact and resolve silences it",
    loop.out.status === 0 &&
      loop.id.length > 0 &&
      loop.before.status === 0 &&
      loop.before.stdout.includes("finish the retry backoff") &&
      loop.resolved.status === 0 &&
      loop.after.status === 0 &&
      !loop.after.stdout.includes("finish the retry backoff"),
    `before=${JSON.stringify(loop.before.stdout.trim())} after=${JSON.stringify(loop.after.stdout.trim())}`,
  );

  const missing = withRepo((dir) => cli(["resolve", "ZZZZZZZZ", "-C", dir]));
  check(
    "resolve on an unknown id fails soft",
    missing.status !== 0 &&
      missing.stdout.includes('no fact found for "ZZZZZZZZ"') &&
      !/Error|stack|Trace/i.test(missing.stdout + missing.stderr),
    `status=${missing.status} stdout=${JSON.stringify(missing.stdout.trim())}`,
  );

  const checks = 7;
  const pass = passed === checks && cliFailures === 0 && openLoopLeaksAfterResolve === 0;
  return { checks, passed, detail, cliFailures, openLoopLeaksAfterResolve, pass };
}

export function formatCoreMemoryLifecycleReport(r: CoreMemoryLifecycleReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval — core memory lifecycle (CLI)");
  lines.push("=".repeat(72));
  lines.push("");
  for (const d of r.detail) lines.push(`  ${d}`);
  lines.push("");
  lines.push(
    `  checks: ${r.passed}/${r.checks}   cli failures: ${r.cliFailures}   post-resolve open-loop leaks: ${r.openLoopLeaksAfterResolve}`,
  );
  lines.push(
    r.pass
      ? "  VERDICT: ✅ CORE MEMORY PASS — remember/recall/why/open-loop lifecycle protected."
      : "  VERDICT: ❌ CORE MEMORY FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function compactWhy(out: string): string {
  const lines = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("asserted by") || l.includes("raw quote") || l.includes("chain"));
  return lines.join(" | ");
}

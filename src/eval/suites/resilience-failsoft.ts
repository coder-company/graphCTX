import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleHook } from "../../adapters/claude-code/hooks.js";
import { nullProvider, resolveProvider } from "../../llm/provider.js";
import { Runtime } from "../../runtime.js";

export interface ResilienceFailsoftReport {
  checks: number;
  passed: number;
  detail: string[];
  cliFailures: number;
  deterministicFactsAfterSessionStart: number;
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

export async function runResilienceFailsoftEval(): Promise<ResilienceFailsoftReport> {
  const detail: string[] = [];
  let passed = 0;
  let cliFailures = 0;
  let deterministicFactsAfterSessionStart = 0;

  const check = (name: string, ok: boolean, note?: string) => {
    if (ok) passed += 1;
    detail.push(`${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
  };

  const deterministicOnly = withFixtureRepo((dir) => {
    const init = cli(["init", "-C", dir], undefined, withoutApiKeys());
    const hook = cli(
      ["hook", "PostCompact", "-C", dir],
      JSON.stringify({ session_id: "s", cwd: dir }),
      withoutApiKeys(),
    );
    return { init, hook };
  });
  if (deterministicOnly.init.status !== 0 || deterministicOnly.hook.status !== 0) cliFailures += 1;
  const deterministicCapsule = parseHookOutput(deterministicOnly.hook.stdout);
  check(
    "deterministic-only no-key mode emits a well-formed capsule and HOOK_EXIT=0",
    deterministicOnly.init.status === 0 &&
      deterministicOnly.hook.status === 0 &&
      deterministicCapsule.includes("[mem:") &&
      !/Error|stack|Trace|sk-ant|OPENAI_API_KEY|ANTHROPIC_API_KEY/i.test(
        deterministicOnly.hook.stdout + deterministicOnly.hook.stderr,
      ),
    `HOOK_EXIT=${deterministicOnly.hook.status} cards=${countMemTags(deterministicCapsule)}`,
  );

  const corrupt = withTempDir((dir) => {
    mkdirSync(join(dir, ".graphctx"), { recursive: true });
    writeFileSync(join(dir, ".graphctx", "workspace.db"), "this is not a sqlite database");
    return cli(["hook", "PostCompact", "-C", dir], JSON.stringify({ session_id: "s", cwd: dir }));
  });
  if (corrupt.status !== 0) cliFailures += 1;
  check(
    "corrupt SQLite DB -> empty output exit 0",
    corrupt.status === 0 && corrupt.stdout.trim() === "",
    `status=${corrupt.status} stdout=${JSON.stringify(corrupt.stdout.trim())}`,
  );

  const config = evaluateBadConfigCases();
  if (!config.invalidJson.ok || !config.schemaInvalid.ok) cliFailures += 1;
  check(
    "invalid JSON config and schema-invalid config -> empty output exit 0",
    config.invalidJson.ok && config.schemaInvalid.ok,
    `invalid=${config.invalidJson.status}/${JSON.stringify(
      config.invalidJson.stdout,
    )} schema=${config.schemaInvalid.status}/${JSON.stringify(config.schemaInvalid.stdout)}`,
  );

  const missingGit = await withTempDirAsync(async (dir) => {
    const rt = new Runtime({ workspaceDir: dir, userId: "resilience-eval" });
    try {
      const result = await handleHook(rt, "PostCompact", { session_id: "s", cwd: dir });
      return !!result.capsule && typeof result.stdout === "string";
    } finally {
      rt.close();
    }
  });
  check("missing git non-repo -> handleHook does not throw", missingGit);

  const plannerCrash = await withTempDirAsync(async (dir) => {
    const rt = new Runtime({ workspaceDir: dir, userId: "resilience-eval" });
    try {
      rt.planner = () => {
        throw new Error("simulated planner crash");
      };
      const result = await handleHook(rt, "PostCompact", { session_id: "s", cwd: dir });
      return (
        result.stdout === "" && result.capsule.markdown === "" && result.capsule.cards.length === 0
      );
    } finally {
      rt.close();
    }
  });
  check("planner crash mid-hook -> empty capsule, never propagates", plannerCrash);

  const hookCaptureRedaction = await evaluateHookCaptureRedaction();
  check(
    "secret-bearing hook payloads are redacted before episode persistence",
    hookCaptureRedaction.ok,
    `storedSecret=${hookCaptureRedaction.secretLeaked} redacted=${hookCaptureRedaction.redacted}`,
  );

  const provider = await evaluateProviderFailsoft();
  check(
    "provider resolution fail-soft: missing key and missing adapter return nullProvider",
    provider.noKeyUnavailable && provider.missingAdapterUnavailable,
    `noKey=${provider.noKeyId} missingAdapter=${provider.missingAdapterId}`,
  );

  const extract = withFixtureRepo((dir) =>
    cli(["extract", "-C", dir], undefined, withoutApiKeys()),
  );
  if (extract.status !== 0) cliFailures += 1;
  check(
    "LLM enrichment without a key is a deterministic-only no-op",
    extract.status === 0 &&
      /Extracted \d+ facts/.test(extract.stdout) &&
      !/Error|stack|Trace|sk-ant|OPENAI_API_KEY|ANTHROPIC_API_KEY/i.test(
        extract.stdout + extract.stderr,
      ),
    `${firstLine(extract.stdout)} EXIT=${extract.status}`,
  );

  const sessionStart = withFixtureRepo((dir) => {
    initGitRepo(dir, true);
    const before = cli(["doctor", "-C", dir]);
    const hook = cli(
      ["hook", "SessionStart", "-C", dir],
      JSON.stringify({ session_id: "s", cwd: dir }),
    );
    const after = cli(["doctor", "-C", dir]);
    return { before, hook, after };
  });
  if (sessionStart.hook.status !== 0) cliFailures += 1;
  const beforeFacts = factsStored(sessionStart.before.stdout);
  const afterFacts = factsStored(sessionStart.after.stdout);
  deterministicFactsAfterSessionStart = afterFacts;
  check(
    "SessionStart hook reruns deterministic extraction so facts go 0 -> N",
    sessionStart.hook.status === 0 && beforeFacts === 0 && afterFacts > 0,
    `facts stored: ${beforeFacts} -> ${afterFacts}`,
  );

  const sessionEnd = withTempDir((dir) => {
    initGitRepo(dir, false);
    return cli(["hook", "SessionEnd", "-C", dir], JSON.stringify({ session_id: "s", cwd: dir }));
  });
  if (sessionEnd.status !== 0) cliFailures += 1;
  check(
    "SessionEnd hook runs promotion sweep fail-soft with EXIT=0",
    sessionEnd.status === 0 && !/Error|stack|Trace/i.test(sessionEnd.stdout + sessionEnd.stderr),
    `EXIT=${sessionEnd.status}`,
  );

  const checks = detail.length;
  const pass = passed === checks && cliFailures === 0 && deterministicFactsAfterSessionStart > 0;
  return { checks, passed, detail, cliFailures, deterministicFactsAfterSessionStart, pass };
}

export function formatResilienceFailsoftReport(r: ResilienceFailsoftReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval - resilience fail-soft");
  lines.push("=".repeat(72));
  lines.push("");
  for (const d of r.detail) lines.push(`  ${d}`);
  lines.push("");
  lines.push(
    `  checks: ${r.passed}/${r.checks}   cli failures: ${r.cliFailures}   SessionStart facts: ${r.deterministicFactsAfterSessionStart}`,
  );
  lines.push(
    r.pass
      ? "  VERDICT: ✅ RESILIENCE PASS - broken dependencies degrade to no-memory, never a broken agent."
      : "  VERDICT: ❌ RESILIENCE FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function evaluateBadConfigCases(): {
  invalidJson: { ok: boolean; status: number; stdout: string };
  schemaInvalid: { ok: boolean; status: number; stdout: string };
} {
  const invalidJson = withTempDir((dir) => {
    mkdirSync(join(dir, ".graphctx"), { recursive: true });
    writeFileSync(join(dir, ".graphctx", "config.json"), "{ this is not valid json ,,, }");
    const res = cli(
      ["hook", "SessionStart", "-C", dir],
      JSON.stringify({ session_id: "s", cwd: dir }),
    );
    return { ok: res.status === 0 && res.stdout.trim() === "", ...res };
  });
  const schemaInvalid = withTempDir((dir) => {
    mkdirSync(join(dir, ".graphctx"), { recursive: true });
    writeFileSync(
      join(dir, ".graphctx", "config.json"),
      JSON.stringify({ inject: { total_budget_tokens: -999, max_cards: "lots" } }),
    );
    const res = cli(
      ["hook", "PostCompact", "-C", dir],
      JSON.stringify({ session_id: "s", cwd: dir }),
    );
    return { ok: res.status === 0 && res.stdout.trim() === "", ...res };
  });
  return { invalidJson, schemaInvalid };
}

async function evaluateHookCaptureRedaction(): Promise<{
  ok: boolean;
  secretLeaked: boolean;
  redacted: boolean;
}> {
  return withTempDirAsync(async (dir) => {
    const secret = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
    const rt = new Runtime({ workspaceDir: dir, userId: "resilience-eval" });
    try {
      await handleHook(rt, "UserPromptSubmit", {
        session_id: "s-redact",
        cwd: dir,
        prompt: `deploy with token ${secret}`,
        tool_name: "Bash",
        tool_input: {
          command: `curl -H 'Authorization: Bearer ${secret}' https://example.invalid`,
          env: { GITHUB_TOKEN: secret },
        },
        tool_response: {
          success: false,
          stderr: `request failed for token ${secret}`,
          stdout: `ignored stdout ${secret}`,
        },
      });
      const stored = JSON.stringify(rt.episodes.bySession("s-redact").map((e) => e.payload));
      const secretLeaked = stored.includes(secret);
      const redacted = stored.includes("[REDACTED:");
      return { ok: !secretLeaked && redacted, secretLeaked, redacted };
    } finally {
      rt.close();
    }
  });
}

async function evaluateProviderFailsoft(): Promise<{
  noKeyUnavailable: boolean;
  missingAdapterUnavailable: boolean;
  noKeyId: string;
  missingAdapterId: string;
}> {
  const noKey = await resolveProvider({
    provider: "anthropic",
    chatModel: "claude-haiku-4-5",
    embedModel: "unused",
    apiKeyEnv: "GRAPHCTX_DEFINITELY_UNSET_KEY",
  });
  const oldFakeKey = process.env.GRAPHCTX_FAKE_PRESENT_KEY;
  process.env.GRAPHCTX_FAKE_PRESENT_KEY = "present-but-no-adapter";
  const missingAdapter = await resolveProvider({
    provider: "missing" as "anthropic",
    chatModel: "unused",
    embedModel: "unused",
    apiKeyEnv: "GRAPHCTX_FAKE_PRESENT_KEY",
  });
  if (oldFakeKey === undefined) Reflect.deleteProperty(process.env, "GRAPHCTX_FAKE_PRESENT_KEY");
  else process.env.GRAPHCTX_FAKE_PRESENT_KEY = oldFakeKey;
  return {
    noKeyUnavailable: noKey.available === false,
    missingAdapterUnavailable:
      missingAdapter.available === false && missingAdapter === nullProvider,
    noKeyId: noKey.id,
    missingAdapterId: missingAdapter.id,
  };
}

function cli(args: string[], input?: string, env: NodeJS.ProcessEnv = process.env): CliResult {
  try {
    const stdout = execFileSync(tsxBin, [cliPath, ...args], {
      cwd: repoRoot,
      env,
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

function initGitRepo(dir: string, commit: boolean): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "."], {
    cwd: dir,
    env: GIT_ENV,
    stdio: "ignore",
  });
  if (!commit) return;
  execFileSync("git", ["add", "-A"], { cwd: dir, env: GIT_ENV, stdio: "ignore" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], {
    cwd: dir,
    env: GIT_ENV,
    stdio: "ignore",
  });
}

function withFixtureRepo<T>(fn: (dir: string) => T): T {
  return withTempDir((dir) => {
    const work = join(dir, "repo");
    cpSync(fixtureRepo, work, { recursive: true });
    return fn(work);
  });
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "graphctx-resilience-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "graphctx-resilience-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withoutApiKeys(): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _anthropic, OPENAI_API_KEY: _openai, ...env } = process.env;
  env.GRAPHCTX_FAKE_PRESENT_KEY = "present-but-no-sdk";
  return env;
}

function parseHookOutput(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    return parsed.hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return "";
  }
}

function countMemTags(text: string): number {
  return text.match(/\[mem:[A-Z0-9]+\]/g)?.length ?? 0;
}

function factsStored(stdout: string): number {
  const m = stdout.match(/facts stored:\s+(\d+)/i);
  return m ? Number(m[1]) : -1;
}

function firstLine(stdout: string): string {
  return (
    stdout
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? ""
  );
}

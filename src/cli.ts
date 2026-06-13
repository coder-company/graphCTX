#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { handleHook } from "./adapters/claude-code/hooks.js";
import { installClaudeHooks, uninstallClaudeHooks } from "./adapters/claude-code/install.js";
import {
  AGENTS_BEGIN,
  AGENTS_END,
  renderAgentsCapsule,
} from "./adapters/claude-code/templates/agents.js";
import { isoNow } from "./core/clock.js";
import { GraphCtxError } from "./core/errors.js";
import { runEval } from "./eval/harness.js";
import { formatReport } from "./eval/report.js";
import { renderCard } from "./render/cards.js";
import { Runtime } from "./runtime.js";

const program = new Command();
program
  .name("graphctx")
  .description("Local-first memory control plane for coding agents")
  .version("0.0.0");

program
  .command("init")
  .description("create stores, run extraction, write AGENTS.md boot capsule")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .action(async (opts) => {
    const rt = new Runtime({ workspaceDir: opts.cwd });
    const res = await rt.extract();
    writeAgentsCapsule(rt);
    process.stdout.write(
      `graphctx initialized at ${rt.workspaceDir}\n  workspace db: ${rt.loaded.paths.workspaceDb}\n  facts extracted: ${res.inserted.length} (secrets skipped: ${res.skippedSecret}, dupes: ${res.skippedDuplicate})\n  AGENTS.md boot capsule written\n`,
    );
    rt.close();
  });

program
  .command("install")
  .argument("<client>", "client to install hooks for (claude)")
  .description("wire client lifecycle hooks to graphctx")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .option("--global", "install to user-level config", false)
  .option("--bin <path>", "command used to invoke graphctx hook", "graphctx")
  .action(async (client, opts) => {
    if (client !== "claude") {
      fail(`unknown client "${client}" (M0 supports: claude)`);
    }
    const rt = new Runtime({ workspaceDir: opts.cwd });
    const { settingsPath } = installClaudeHooks({
      workspaceDir: rt.workspaceDir,
      global: opts.global,
      binPath: opts.bin,
    });
    await rt.extract();
    writeAgentsCapsule(rt);
    process.stdout.write(
      `Installed Claude Code hooks → ${settingsPath}\ngraphctx will push memory at SessionStart and PostCompact.\n`,
    );
    rt.close();
  });

program
  .command("uninstall")
  .argument("<client>", "client to remove hooks for (claude)")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .option("--global", "remove from user-level config", false)
  .action((client, opts) => {
    if (client !== "claude") fail(`unknown client "${client}"`);
    uninstallClaudeHooks({ workspaceDir: opts.cwd, global: opts.global });
    process.stdout.write("Removed graphctx Claude Code hooks.\n");
  });

program
  .command("hook")
  .argument("<event>", "lifecycle event name")
  .description("internal: invoked by client hooks; reads JSON payload on stdin")
  .option("-C, --cwd <dir>", "workspace directory")
  .action(async (event, opts) => {
    // I9: this path must never crash the agent. Any failure → empty output.
    try {
      const raw = await readStdin();
      const payload = raw ? safeParse(raw) : {};
      const cwd = opts.cwd ?? payload.cwd ?? process.cwd();
      const rt = new Runtime({ workspaceDir: cwd });
      const result = await handleHook(rt, event, payload);
      if (result.stdout) process.stdout.write(result.stdout);
      rt.close();
    } catch (e) {
      logError(e);
      // emit nothing → no memory, not a broken agent
    }
    process.exit(0);
  });

program
  .command("recall")
  .argument("<query>", "search query")
  .description("pull retrieval (fallback path; push is primary)")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .option("-b, --budget <n>", "token budget", "1000")
  .option("--session <id>", "session id")
  .action(async (query, opts) => {
    const rt = new Runtime({ workspaceDir: opts.cwd });
    const ctx = await rt.injectionContext("UserPromptSubmit", opts.session ?? "recall", {
      user_prompt: query,
      budget_tokens: Number(opts.budget),
    });
    const { Retriever } = await import("./retrieve/retriever.js");
    const retriever = new Retriever(rt.facts, rt.git);
    const scored = await retriever.retrieve(ctx, { includeAllActive: true });
    if (scored.length === 0) {
      process.stdout.write("(no matching memory)\n");
    } else {
      for (const s of scored.slice(0, 15)) {
        process.stdout.write(`${renderCard(s.fact).markdown}  (score ${s.score.toFixed(2)})\n`);
      }
    }
    rt.close();
  });

program
  .command("remember")
  .argument("<text>", 'the fact text, e.g. "deploy with ./scripts/ship.sh"')
  .description("store a user-asserted workspace fact (active, high-trust)")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .option("--subject <s>", "fact subject", "repo")
  .option("--predicate <p>", "fact predicate", "note")
  .option("--kind <k>", "fact kind", "decision")
  .action(async (text, opts) => {
    const rt = new Runtime({ workspaceDir: opts.cwd });
    let head: string | undefined;
    let branch: string | undefined;
    let repoId: string | undefined;
    if (await rt.git.isRepo()) {
      try {
        head = await rt.git.head();
        branch = await rt.git.branch();
        repoId = await rt.git.repoId();
      } catch {
        // degrade without anchors
      }
    }
    const fact = rt.facts.insert({
      subject: opts.subject,
      predicate: opts.predicate,
      object: text,
      fact_kind: opts.kind,
      temporal_kind: "static",
      scope: { user_id: rt.userId, workspace_id: rt.workspaceId },
      trust_tier: "high",
      status: "active",
      promotion_state: "workspace_active",
      source: { asserted_by: "user", event_ids: [], raw_quote: `user said: ${text}` },
      git: { repo_id: repoId, branch, valid_from_commit: head, introduced_by_commit: head },
      tags: ["user_explicit"],
    });
    process.stdout.write(`Remembered ${fact.fact_id}: ${renderCard(fact).markdown}\n`);
    rt.close();
  });

program
  .command("extract")
  .description("run deterministic extractors against the workspace")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .action(async (opts) => {
    const rt = new Runtime({ workspaceDir: opts.cwd });
    const res = await rt.extract();
    process.stdout.write(
      `Extracted ${res.inserted.length} facts (secrets skipped: ${res.skippedSecret}, dupes: ${res.skippedDuplicate}).\n`,
    );
    for (const f of res.inserted) process.stdout.write(`  ${renderCard(f).markdown}\n`);
    rt.close();
  });

program
  .command("serve")
  .option("--mcp", "run as MCP server")
  .description("run the MCP server (M1+; not part of the M0 spike)")
  .action(() => {
    process.stdout.write(
      "graphctx serve --mcp is implemented in M1. M0 uses Claude Code hooks (push) only.\n",
    );
  });

program
  .command("doctor")
  .description("health check: db, git, hooks, config")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .action(async (opts) => {
    const rt = new Runtime({ workspaceDir: opts.cwd });
    const isRepo = await rt.git.isRepo();
    const factCount = rt.facts.all({ user_id: rt.userId, workspace_id: rt.workspaceId }).length;
    const hooks = existsSync(join(rt.workspaceDir, ".claude", "settings.json"));
    process.stdout.write(
      `graphctx doctor\n  workspace: ${rt.workspaceDir}\n  db: ${rt.loaded.paths.workspaceDb} (ok)\n  git repo: ${isRepo ? "yes" : "no"}\n  facts stored: ${factCount}\n  claude hooks: ${hooks ? "installed" : "not installed"}\n`,
    );
    rt.close();
  });

program
  .command("bench")
  .description("measure hook hot-path latency (SPEC §24: < 150ms p95)")
  .option("--repo <dir>", "fixture repo to bench", "fixtures/repo-pnpm-web")
  .option("-n, --iterations <n>", "iterations", "50")
  .option("-C, --cwd <dir>", "base directory", process.cwd())
  .action(async (opts) => {
    const { measureHookLatency } = await import("./eval/latency.js");
    const repo = join(opts.cwd, opts.repo);
    const r = await measureHookLatency(repo, Number(opts.iterations));
    process.stdout.write(
      `graphctx hook latency (${r.iterations} iters, retrieval + render)\n  p50: ${r.p50}ms   p95: ${r.p95}ms   p99: ${r.p99}ms   max: ${r.max}ms\n  budget: < ${r.budgetMs}ms p95  →  ${r.pass ? "PASS ✅" : "FAIL ❌"}\n`,
    );
    if (!r.pass) process.exitCode = 1;
  });

program
  .command("eval")
  .argument("<sub>", "subcommand: run")
  .description("run evaluation suites")
  .option("--suite <name>", "suite name", "compaction-recovery")
  .option(
    "--arms <arms>",
    "comma-separated arms (A,B,C solve; N,S integrity controls)",
    "A,B,C,N,S",
  )
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .action(async (sub, opts) => {
    if (sub !== "run") fail(`unknown eval subcommand "${sub}"`);
    const arms = String(opts.arms)
      .split(",")
      .map((a) => a.trim());
    const report = await runEval({ suite: opts.suite, arms, baseDir: opts.cwd });
    process.stdout.write(formatReport(report));
  });

program.parseAsync(process.argv);

// ---- helpers ----

function writeAgentsCapsule(rt: Runtime): void {
  const facts = rt.facts
    .activeAsOf({ user_id: rt.userId, workspace_id: rt.workspaceId })
    .filter((f) => f.trust_tier === "high")
    .slice(0, 12)
    .map((f) =>
      renderCard(f)
        .markdown.replace(/^- /, "")
        .replace(/\s*\[mem:[^\]]+\]$/, ""),
    );
  const capsule = renderAgentsCapsule({ facts, generatedAt: isoNow() });
  const path = join(rt.workspaceDir, "AGENTS.md");
  let content = capsule;
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing.includes(AGENTS_BEGIN) && existing.includes(AGENTS_END)) {
      content = existing.replace(
        new RegExp(`${escapeRe(AGENTS_BEGIN)}[\\s\\S]*${escapeRe(AGENTS_END)}`),
        capsule,
      );
    } else {
      content = `${existing.trimEnd()}\n\n${capsule}\n`;
    }
  } else {
    content = `${capsule}\n`;
  }
  mkdirSync(rt.workspaceDir, { recursive: true });
  writeFileSync(path, content, "utf8");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function logError(e: unknown): void {
  try {
    const dir = join(process.env.HOME ?? "", ".local", "share", "graphctx", "logs");
    mkdirSync(dir, { recursive: true });
    const line = `${isoNow()} ${e instanceof GraphCtxError ? `[${e.code}] ` : ""}${(e as Error)?.message ?? String(e)}\n`;
    writeFileSync(join(dir, "hook-errors.log"), line, { flag: "a" });
  } catch {
    // give up silently — never surface to the agent
  }
}

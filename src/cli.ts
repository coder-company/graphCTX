#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  .argument("<client>", "client: claude | cursor | opencode | generic | auto")
  .description("wire a client to graphctx (hooks for claude; rules+MCP for others)")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .option("--global", "install to user-level config", false)
  .option("--bin <path>", "command used to invoke graphctx", "graphctx")
  .action(async (client, opts) => {
    const rt = new Runtime({ workspaceDir: opts.cwd });
    let resolved = client;
    if (client === "auto") {
      const { detectClient } = await import("./adapters/registry.js");
      resolved = detectClient(rt.workspaceDir);
      process.stdout.write(`auto-detected client: ${resolved}\n`);
    }

    if (resolved === "claude") {
      const { settingsPath } = installClaudeHooks({
        workspaceDir: rt.workspaceDir,
        global: opts.global,
        binPath: opts.bin,
      });
      await rt.extract();
      writeAgentsCapsule(rt);
      process.stdout.write(
        `Installed Claude Code hooks (Tier 2 push) → ${settingsPath}\ngraphctx will push memory at SessionStart and PostCompact.\n`,
      );
      rt.close();
      return;
    }

    if (resolved === "cursor" || resolved === "opencode" || resolved === "generic") {
      const { makeAdapter } = await import("./adapters/registry.js");
      const adapter = makeAdapter(resolved, rt.workspaceDir);
      const cap = await adapter.detect();
      await adapter.install({
        workspaceDir: rt.workspaceDir,
        global: opts.global,
        binPath: opts.bin,
      });
      await rt.extract();
      writeAgentsCapsule(rt);
      process.stdout.write(
        `Installed ${resolved} adapter (tiers ${cap.tiers.join(",")}; highest T${cap.highest}).\nRegistered MCP server + AGENTS.md grounding. Run \`graphctx serve --mcp\` from the client.\n`,
      );
      rt.close();
      return;
    }

    rt.close();
    fail(`unknown client "${client}" (supported: claude, cursor, opencode, generic, auto)`);
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
  .command("loop")
  .argument("<text>", 'the unfinished work, e.g. "finish the retry backoff"')
  .description("record a durable open loop (resurfaces at PostCompact/SessionStart)")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .option("--session <id>", "session id (session-scoped by default)")
  .action(async (text, opts) => {
    const rt = new Runtime({ workspaceDir: opts.cwd });
    const fact = rt.noteOpenLoop(text, opts.session);
    process.stdout.write(`Open loop ${fact.fact_id.slice(-8)}: ${text}\n`);
    rt.close();
  });

program
  .command("resolve")
  .argument("<fact_id>", "open-loop fact id (full or last-8 suffix)")
  .description("resolve an open loop so it stops resurfacing")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .action(async (factArg, opts) => {
    const rt = new Runtime({ workspaceDir: opts.cwd });
    let id = factArg as string;
    if (!rt.facts.get(id)) {
      const match = rt.facts
        .all({ user_id: rt.userId, workspace_id: rt.workspaceId })
        .find((f) => f.fact_id.endsWith(factArg));
      if (match) id = match.fact_id;
    }
    if (!rt.facts.get(id)) {
      process.stdout.write(`no fact found for "${factArg}"\n`);
      process.exitCode = 1;
    } else {
      await rt.resolveOpenLoop(id);
      process.stdout.write(`Resolved open loop ${id.slice(-8)}.\n`);
    }
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
  .option("--mcp", "run as MCP server (stdio JSON-RPC)")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .description("run the graphCTX MCP server (stdio, 8 tools)")
  .action(async (opts) => {
    if (!opts.mcp) {
      process.stdout.write("usage: graphctx serve --mcp\n");
      return;
    }
    const { McpServer } = await import("./mcp/server.js");
    const server = new McpServer({ workspaceDir: opts.cwd });
    await server.serve();
    server.close();
  });

program
  .command("why")
  .description("show the full provenance chain for a fact (events, anchor, gate, edges)")
  .argument("<fact_id>", "fact id (full or last-8 suffix)")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .action(async (factArg, opts) => {
    const { formatWhy } = await import("./provenance/why.js");
    const rt = new Runtime({ workspaceDir: opts.cwd });
    // Accept a last-8 suffix as a convenience (matches the [mem:id] tag).
    let id = factArg as string;
    if (!rt.facts.get(id)) {
      const match = rt.facts
        .all({ user_id: rt.userId, workspace_id: rt.workspaceId })
        .find((f) => f.fact_id.endsWith(factArg));
      if (match) id = match.fact_id;
    }
    const report = rt.why(id);
    if (!report) {
      process.stdout.write(`no fact found for "${factArg}"\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(formatWhy(report));
    }
    rt.close();
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
    const ready = hooks && factCount > 0;
    const verdict = ready
      ? "READY ✅ — hooks installed and memory populated; push is live."
      : !hooks
        ? "NOT READY ❌ — run `graphctx install` to wire the hooks."
        : "NOT READY ❌ — no facts yet; run `graphctx extract`.";
    process.stdout.write(
      `graphctx doctor\n  workspace: ${rt.workspaceDir}\n  db: ${rt.loaded.paths.workspaceDb} (ok)\n  git repo: ${isRepo ? "yes" : "no (anchors degrade gracefully)"}\n  facts stored: ${factCount}\n  claude hooks: ${hooks ? "installed" : "not installed"}\n\n  ${verdict}\n`,
    );
    rt.close();
  });

program
  .command("demo")
  .description("one-command, offline demo setup (push beats pull, live)")
  .option("--dir <dir>", "scratch demo directory", join(tmpdir(), "graphctx-demo"))
  .action(async (opts) => {
    const { setupDemo, DEMO_DEPLOY_CMD } = await import("./adapters/claude-code/demo.js");
    const r = await setupDemo(opts.dir);
    const ask =
      "What is the exact deploy command for this project? Output it verbatim on one line. Do not read files or run tools.";
    process.stdout.write(
      [
        "",
        "graphctx demo — ready ✅  (offline, no network)",
        "=".repeat(70),
        `  demo repo:        ${r.demoDir}`,
        `  hook invocation:  ${r.binInvocation}`,
        `  facts in memory:  ${r.factCount}  (incl. an unfindable deploy command)`,
        "",
        "The deploy command lives ONLY in graphCTX's store — it is in NO repo file.",
        "AGENTS.md was removed, so the SessionStart hook is the ONLY way an agent",
        "can learn it. That isolates the push channel.",
        "",
        "STEP 1 — WITHOUT graphCTX (negative control): the agent cannot know it",
        "-".repeat(70),
        `  cd ${r.demoDir}-bare 2>/dev/null || (cp -r ${r.demoDir} ${r.demoDir}-bare && rm -rf ${r.demoDir}-bare/.graphctx ${r.demoDir}-bare/.claude)`,
        `  cd ${r.demoDir}-bare`,
        `  echo ${JSON.stringify(ask)} | claude -p --permission-mode bypassPermissions`,
        "  → expect: \"I don't know it / it's fresh to me\"",
        "",
        "STEP 2 — WITH graphCTX (push): the SessionStart hook supplies it",
        "-".repeat(70),
        `  cd ${r.demoDir}`,
        `  echo ${JSON.stringify(ask)} | claude -p --permission-mode bypassPermissions`,
        `  → expect: ${DEMO_DEPLOY_CMD}`,
        "",
        "Same agent, same prompt — only difference is the graphCTX hook push.",
        "",
        "Inspect the exact capsule the hook emits:",
        `  echo '{"session_id":"s","cwd":"${r.demoDir}"}' | graphctx hook PostCompact -C ${r.demoDir}`,
        "",
        "Capsule preview (what the agent receives):",
        ...r.capsulePreview.split("\n").map((l) => `  | ${l}`),
        "",
        "Backup evidence (numbers): graphctx eval run --arms A,B,C,N,S",
        "",
      ].join("\n"),
    );
  });

program
  .command("tui")
  .description("interactive terminal UI: dashboard, control panel, live monitor")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .option("--tab <tab>", "initial tab: dashboard | control | monitor", "dashboard")
  .action(async (opts) => {
    const { TuiApp } = await import("./tui/app.js");
    const tab = ["dashboard", "control", "monitor"].includes(opts.tab) ? opts.tab : "dashboard";
    const app = new TuiApp(opts.cwd, tab);
    await app.run();
  });

program
  .command("compare")
  .description("benchmark graphCTX vs Supermemory (multi-axis; --live for API bake-off)")
  .option("--live", "run the live API bake-off (requires SUPERMEMORY_API_KEY)", false)
  .action(async (opts) => {
    const { runBenchmark, formatReport } = await import("./bench/compare.js");
    if (opts.live) process.stdout.write("running live bake-off (ingest + index wait ~12s)…\n");
    const report = await runBenchmark({ live: opts.live });
    process.stdout.write(`${formatReport(report)}\n`);
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
  .argument(
    "<sub>",
    "subcommand: run | promote | drift | branch | conflict | procedure | mcp | all",
  )
  .description("run evaluation suites")
  .option("--suite <name>", "suite name", "compaction-recovery")
  .option(
    "--arms <arms>",
    "comma-separated arms (A,B,C solve; N,S integrity controls)",
    "A,B,C,N,S",
  )
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .action(async (sub, opts) => {
    const runPromote = async () => {
      const { runPromotionEval, formatPromotionReport } = await import("./eval/promotion-eval.js");
      const report = await runPromotionEval();
      process.stdout.write(formatPromotionReport(report));
      return report.pass;
    };
    const runDrift = async () => {
      const { runDriftGateEval, formatDriftGateReport } = await import(
        "./eval/suites/drift-gate.js"
      );
      const report = await runDriftGateEval(opts.cwd);
      process.stdout.write(formatDriftGateReport(report));
      return report.pass;
    };
    const runArms = async () => {
      const arms = String(opts.arms)
        .split(",")
        .map((a) => a.trim());
      const report = await runEval({ suite: opts.suite, arms, baseDir: opts.cwd });
      process.stdout.write(formatReport(report));
      return true;
    };
    const runBranch = async () => {
      const { runBranchTruthEval, formatBranchTruthReport } = await import(
        "./eval/suites/branch-truth.js"
      );
      const r = runBranchTruthEval();
      process.stdout.write(formatBranchTruthReport(r));
      return r.pass;
    };
    const runConflict = async () => {
      const { runParallelConflictEval, formatParallelConflictReport } = await import(
        "./eval/suites/parallel-conflict.js"
      );
      const r = runParallelConflictEval();
      process.stdout.write(formatParallelConflictReport(r));
      return r.pass;
    };
    const runProcedure = async () => {
      const { runProcedureMemoryEval, formatProcedureMemoryReport } = await import(
        "./eval/suites/procedure-memory.js"
      );
      const r = await runProcedureMemoryEval();
      process.stdout.write(formatProcedureMemoryReport(r));
      return r.pass;
    };
    const runMcp = async () => {
      const { runAdaptersMcpEval, formatAdaptersMcpReport } = await import(
        "./eval/suites/adapters-mcp.js"
      );
      const r = await runAdaptersMcpEval(opts.cwd);
      process.stdout.write(formatAdaptersMcpReport(r));
      return r.pass;
    };

    if (sub === "promote") {
      if (!(await runPromote())) process.exitCode = 1;
      return;
    }
    if (sub === "drift") {
      if (!(await runDrift())) process.exitCode = 1;
      return;
    }
    if (sub === "branch") {
      if (!(await runBranch())) process.exitCode = 1;
      return;
    }
    if (sub === "conflict") {
      if (!(await runConflict())) process.exitCode = 1;
      return;
    }
    if (sub === "procedure") {
      if (!(await runProcedure())) process.exitCode = 1;
      return;
    }
    if (sub === "mcp") {
      if (!(await runMcp())) process.exitCode = 1;
      return;
    }
    if (sub === "all") {
      const a = await runArms();
      const p = await runPromote();
      const d = await runDrift();
      const b = await runBranch();
      const c = await runConflict();
      const pr = await runProcedure();
      const m = await runMcp();
      if (!(a && p && d && b && c && pr && m)) process.exitCode = 1;
      return;
    }
    if (sub !== "run") fail(`unknown eval subcommand "${sub}"`);
    await runArms();
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

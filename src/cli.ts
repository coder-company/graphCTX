#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { writeAgentsCapsule } from "./adapters/boot-capsule.js";
import { handleHook } from "./adapters/claude-code/hooks.js";
import { hasClaudeGraphctxHooks, uninstallClaudeHooks } from "./adapters/claude-code/install.js";
import { hasCodexGraphctxInstall } from "./adapters/codex/index.js";
import { hasCursorGraphctxInstall } from "./adapters/cursor/index.js";
import { hasGenericGraphctxInstall } from "./adapters/generic/index.js";
import { hasOpenCodeGraphctxInstall } from "./adapters/opencode/index.js";
import { isoNow } from "./core/clock.js";
import { GraphCtxError } from "./core/errors.js";
import { FACT_KINDS, type FactKind } from "./core/types.js";
import { runEval } from "./eval/harness.js";
import {
  EVAL_GATE_SUITES,
  type EvalGateSuite,
  evalSubcommandHelp,
  isEvalGateSuite,
} from "./eval/registry.js";
import { evalReportPass, formatReport } from "./eval/report.js";
import { renderCard } from "./render/cards.js";
import { Runtime } from "./runtime.js";
import {
  assertSafeExplicitMemoryWrite,
  assertSafeMemoryWrite,
  formatMemoryWriteError,
} from "./security/intake.js";
import { sanitizeRetrievalText } from "./security/retrieval-context.js";
import { redactSecrets } from "./security/secrets.js";
import { safeForSend } from "./security/send-edge.js";
import { bootstrapVec0 } from "./store/vec0-bootstrap.js";
import { VERSION } from "./version.js";

exitOnBrokenPipe(process.stdout);
exitOnBrokenPipe(process.stderr);

const program = new Command();
program
  .name("graphctx")
  .description("Local-first memory control plane for coding agents")
  .version(VERSION);

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
  .argument("<client>", "client: claude | cursor | opencode | codex | generic | auto")
  .description("wire a client to graphctx (hooks for claude; rules+MCP for others)")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .option("--global", "install to user-level config", false)
  .option("--bin <path>", "command used to invoke graphctx")
  .action(async (client, opts) => {
    const rt = new Runtime({ workspaceDir: opts.cwd });
    let resolved = client;
    if (client === "auto") {
      const { detectClient } = await import("./adapters/registry.js");
      resolved = detectClient(rt.workspaceDir);
      process.stdout.write(`auto-detected client: ${resolved}\n`);
    }

    if (
      resolved === "claude" ||
      resolved === "cursor" ||
      resolved === "opencode" ||
      resolved === "codex" ||
      resolved === "generic"
    ) {
      const { makeAdapter } = await import("./adapters/registry.js");
      const adapter = makeAdapter(resolved, rt.workspaceDir);
      const cap = await adapter.detect();
      await adapter.install({
        workspaceDir: rt.workspaceDir,
        global: opts.global,
        binPath: resolveInstallBin(opts.bin),
      });
      await rt.extract();
      writeAgentsCapsule(rt);
      process.stdout.write(
        `Installed ${resolved} adapter (tiers ${cap.tiers.join(",")}; highest T${cap.highest}).\n${installNextStep(resolved)}\n`,
      );
      rt.close();
      return;
    }

    rt.close();
    fail(`unknown client "${client}" (supported: claude, cursor, opencode, codex, generic, auto)`);
  });

program
  .command("uninstall")
  .argument(
    "<client>",
    "client to remove config for (claude | cursor | opencode | codex | generic)",
  )
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .option("--global", "remove from user-level config", false)
  .action(async (client, opts) => {
    if (client === "claude") {
      uninstallClaudeHooks({ workspaceDir: opts.cwd, global: opts.global });
      process.stdout.write("Removed graphctx Claude Code hooks.\n");
      return;
    }
    if (
      client === "cursor" ||
      client === "opencode" ||
      client === "codex" ||
      client === "generic"
    ) {
      const { makeAdapter } = await import("./adapters/registry.js");
      const adapter = makeAdapter(client, resolve(opts.cwd));
      await adapter.uninstall();
      process.stdout.write(`Removed graphctx ${client} adapter config.\n`);
      return;
    }
    fail(`unknown client "${client}" (supported: claude, cursor, opencode, codex, generic)`);
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
    const budget = parsePositiveIntegerOption(opts.budget, "--budget");
    const rt = new Runtime({ workspaceDir: opts.cwd });
    const ctx = await rt.injectionContext("UserPromptSubmit", opts.session ?? "recall", {
      user_prompt: sanitizeRetrievalText(query),
      budget_tokens: budget,
    });
    const { Retriever } = await import("./retrieve/retriever.js");
    const retriever = new Retriever(rt.facts, rt.git, rt.vectors, rt.clock);
    const scored = (await retriever.retrieve(ctx, { includeAllActive: true })).filter((s) =>
      safeForSend(s.fact),
    );
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
    const kind = parseFactKindOption(opts.kind);
    try {
      assertSafeExplicitMemoryWrite({
        text,
        subject: opts.subject,
        predicate: opts.predicate,
        kind,
      });
    } catch (e) {
      fail(formatMemoryWriteError(e));
    }
    const rt = new Runtime({ workspaceDir: opts.cwd });
    const fact = await rt.rememberFact({
      text,
      subject: opts.subject,
      predicate: opts.predicate,
      kind,
    });
    refreshAgentsCapsule(rt);
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
    try {
      assertSafeExplicitMemoryWrite({ text, session_id: opts.session });
    } catch (e) {
      fail(formatMemoryWriteError(e));
    }
    const rt = new Runtime({ workspaceDir: opts.cwd });
    const fact = await rt.noteOpenLoop(text, opts.session);
    refreshAgentsCapsule(rt);
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
    const id = rt.resolveFactId(factArg);
    if (!id) {
      process.stdout.write(`no fact found for "${redactSecrets(factArg)}"\n`);
      process.exitCode = 1;
    } else {
      await rt.resolveOpenLoop(id);
      refreshAgentsCapsule(rt);
      process.stdout.write(`Resolved open loop ${id.slice(-8)}.\n`);
    }
    rt.close();
  });

program
  .command("extract")
  .description("run deterministic extractors against the workspace")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .option(
    "--rank <strategy>",
    "additional repo-map ranker (currently only: pagerank). Implies env GRAPHCTX_EXTRACT_PAGERANK=1.",
  )
  .action(async (opts) => {
    if (opts.rank) {
      if (opts.rank !== "pagerank") {
        fail(`--rank must be 'pagerank' (got ${opts.rank})`);
      }
      process.env.GRAPHCTX_EXTRACT_PAGERANK = "1";
    }
    const rt = new Runtime({ workspaceDir: opts.cwd });
    const res = await rt.extract();
    refreshAgentsCapsule(rt);
    process.stdout.write(
      `Extracted ${res.inserted.length} facts (secrets skipped: ${res.skippedSecret}, dupes: ${res.skippedDuplicate}).\n`,
    );
    for (const f of res.inserted) process.stdout.write(`  ${renderCard(f).markdown}\n`);
    rt.close();
  });

program
  .command("serve")
  .option("--mcp", "run as MCP server (stdio JSON-RPC)")
  .option(
    "--socket <path>",
    "(daemon mode) bind to a local Unix socket; one server, many concurrent clients",
  )
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .description("run the graphCTX MCP server (stdio by default, 8 tools)")
  .action(async (opts) => {
    if (!opts.mcp) {
      process.stdout.write("usage: graphctx serve --mcp [--socket <path>]\n");
      return;
    }
    const { McpServer } = await import("./mcp/server.js");
    const server = new McpServer({ workspaceDir: opts.cwd });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      server.close();
    };
    const onSignal = () => {
      close();
      process.exit(0);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      if (opts.socket) {
        await server.serveSocket(resolve(opts.socket));
      } else {
        await server.serve();
      }
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      close();
    }
  });

program
  .command("why")
  .description("show the full provenance chain for a fact (events, anchor, gate, edges)")
  .argument("<fact_id>", "fact id (full or last-8 suffix)")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .option(
    "--at <iso>",
    "bi-temporal as-of cursor (ISO-8601); only show evidence recorded at or before this time",
  )
  .action(async (factArg, opts) => {
    const { formatWhy } = await import("./provenance/why.js");
    const asOf = parseAsOfOption(opts.at);
    const rt = new Runtime({ workspaceDir: opts.cwd });
    // Accept a last-8 suffix as a convenience (matches the [mem:id] tag).
    const id = rt.resolveFactId(factArg);
    const report = id ? rt.why(id, { asOf }) : null;
    if (!report) {
      if (asOf && id) {
        process.stdout.write(`fact ${id.slice(-8)} did not exist at ${asOf} (try without --at)\n`);
      } else {
        process.stdout.write(`no fact found for "${redactSecrets(factArg)}"\n`);
      }
      process.exitCode = 1;
    } else {
      if (asOf) process.stdout.write(`(as of ${asOf})\n`);
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
    const readiness = adapterReadiness(rt.workspaceDir);
    const verdict = doctorVerdict(readiness, factCount);
    process.stdout.write(
      `graphctx doctor\n  workspace: ${rt.workspaceDir}\n  db: ${rt.loaded.paths.workspaceDb} (ok)\n  git repo: ${isRepo ? "yes" : "no (anchors degrade gracefully)"}\n  facts stored: ${factCount}\n  claude hooks: ${readiness.claude ? "installed" : "not installed"}\n  cursor MCP: ${readiness.cursor ? "installed" : "not installed"}\n  opencode MCP: ${readiness.opencode ? "installed" : "not installed"}\n  codex MCP: ${readiness.codex ? "installed" : "not installed"}\n  generic grounding: ${readiness.generic ? "installed" : "not installed"}\n\n  ${verdict}\n`,
    );
    rt.close();
  });

program
  .command("demo")
  .description("one-command, offline demo setup (push beats pull, live)")
  .option("--dir <dir>", "scratch demo directory", join(tmpdir(), "graphctx-demo"))
  .action(async (opts) => {
    if (!requireDevCheckout("demo")) return;
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
  .command("skill")
  .argument("<client>", "client: claude | cursor | opencode | codex | generic (or all)")
  .description("install a graphCTX agent-skill file for a coding-agent host")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .option("--bin <path>", "command used to invoke graphctx inside the skill template")
  .option("--force", "overwrite an existing skill file", false)
  .action(async (client, opts) => {
    const { SKILL_CLIENTS, installSkill, isSkillClient } = await import(
      "./adapters/skill/index.js"
    );
    const targets =
      client === "all"
        ? [...SKILL_CLIENTS]
        : isSkillClient(client)
          ? [client]
          : (fail(
              `unknown skill client "${client}" (supported: ${SKILL_CLIENTS.join(", ")}, all)`,
            ) as never);
    for (const c of targets) {
      const t = installSkill({
        workspaceDir: resolve(opts.cwd),
        client: c,
        binPath: resolveInstallBin(opts.bin),
        force: Boolean(opts.force),
      });
      process.stdout.write(`${t.existed ? "Refreshed" : "Installed"} ${c} skill → ${t.path}\n`);
    }
  });

program
  .command("tui")
  .description("interactive terminal UI: dashboard, control panel, live monitor")
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .option("--tab <tab>", "initial tab: dashboard | control | monitor", "dashboard")
  .action(async (opts) => {
    const { TuiApp } = await import("./tui/app.js");
    const tab = parseTuiTabOption(opts.tab);
    const app = new TuiApp(opts.cwd, tab);
    await app.run();
  });

program
  .command("compare")
  .description("benchmark graphCTX vs Supermemory (multi-axis; --live for API bake-off)")
  .option("--live", "run the live API bake-off (requires SUPERMEMORY_API_KEY)", false)
  .option("--deep", "run deep scenarios: latency dists, scale, push-vs-pull", false)
  .option("--json", "emit machine-readable JSON (with --deep)", false)
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .action(async (opts) => {
    if (!requireDevCheckout("compare")) return;
    if (opts.deep) {
      const { runScenarios } = await import("./bench/scenarios.js");
      if (!opts.json)
        process.stdout.write("running deep scenarios (scale + latency dists + live)…\n");
      const report = await runScenarios({ baseDir: opts.cwd });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        const { formatScenarios } = await import("./bench/scenarios-report.js");
        process.stdout.write(`${formatScenarios(report)}\n`);
      }
      return;
    }
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
  .option("--scale", "measure hot-path retrieval p50/p95/p99 at 1k-100k facts", false)
  .option("--footprint", "measure cold startup-to-first-result latency and memory footprint", false)
  .option("--sizes <list>", "comma-separated corpus sizes for --scale", "1000,10000,50000,100000")
  .option("--budget-ms <n>", "p95 budget for --scale in milliseconds", "150")
  .option("-C, --cwd <dir>", "base directory", process.cwd())
  .action(async (opts) => {
    if (!requireDevCheckout("bench")) return;
    if (opts.footprint) {
      const { measureFootprint, formatFootprintReport } = await import("./bench/scale.js");
      process.stdout.write("running startup/footprint benchmark…\n");
      const report = await measureFootprint();
      process.stdout.write(`${formatFootprintReport(report)}\n`);
      if (!report.pass) process.exitCode = 1;
      return;
    }
    if (opts.scale) {
      const { runScaleBenchmark, formatScaleReport, parseScaleSizes } = await import(
        "./bench/scale.js"
      );
      let sizes: number[];
      try {
        sizes = parseScaleSizes(String(opts.sizes));
      } catch (e) {
        fail((e as Error).message);
      }
      const budgetMs = parsePositiveNumberOption(opts.budgetMs, "--budget-ms");
      process.stdout.write("running scale benchmark (streaming bulk ingest; 1M may take a bit)…\n");
      const report = await runScaleBenchmark({
        sizes,
        budgetMs,
      });
      process.stdout.write(`${formatScaleReport(report)}\n`);
      if (!report.pass) process.exitCode = 1;
      return;
    }
    const { measureHookLatency } = await import("./eval/latency.js");
    const repo = join(opts.cwd, opts.repo);
    const iterations = parsePositiveIntegerOption(opts.iterations, "--iterations");
    const r = await measureHookLatency(repo, iterations);
    process.stdout.write(
      `graphctx hook latency (${r.iterations} iters, retrieval + render)\n  p50: ${r.p50}ms   p95: ${r.p95}ms   p99: ${r.p99}ms   max: ${r.max}ms\n  budget: < ${r.budgetMs}ms p95  →  ${r.pass ? "PASS ✅" : "FAIL ❌"}\n`,
    );
    if (!r.pass) process.exitCode = 1;
  });

program
  .command("eval")
  .argument("<sub>", evalSubcommandHelp())
  .description("run evaluation suites")
  .option("--suite <name>", "suite name", "compaction-recovery")
  .option(
    "--arms <arms>",
    "comma-separated arms (A,B,C solve; N,S integrity controls)",
    "A,B,C,N,S",
  )
  .option("-C, --cwd <dir>", "workspace directory", process.cwd())
  .option("--live", "run opt-in live provider checks (requires GRAPHCTX_LLM_LIVE=1)", false)
  .action(async (sub, opts) => {
    if (!requireDevCheckout("eval")) return;
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
    const runRetrieval = async () => {
      const { runRetrievalQualityEval, formatRetrievalQualityReport } = await import(
        "./eval/suites/retrieval-quality.js"
      );
      const report = await runRetrievalQualityEval();
      process.stdout.write(formatRetrievalQualityReport(report));
      return report.pass;
    };
    const runArms = async () => {
      const arms = String(opts.arms)
        .split(",")
        .map((a) => a.trim());
      const report = await runEval({ suite: opts.suite, arms, baseDir: opts.cwd });
      process.stdout.write(formatReport(report));
      return evalReportPass(report);
    };
    const runMemory = async () => {
      const { runCoreMemoryLifecycleEval, formatCoreMemoryLifecycleReport } = await import(
        "./eval/suites/core-memory-lifecycle.js"
      );
      const r = runCoreMemoryLifecycleEval();
      process.stdout.write(formatCoreMemoryLifecycleReport(r));
      return r.pass;
    };
    const runGate = async () => {
      const { runGatePrecisionEval, formatGatePrecisionReport } = await import(
        "./eval/suites/gate-precision.js"
      );
      const report = runGatePrecisionEval();
      process.stdout.write(formatGatePrecisionReport(report));
      return report.pass;
    };
    const runSecurity = async () => {
      const { runSecurityAdversarialEval, formatSecurityAdversarialReport } = await import(
        "./eval/suites/security-adversarial.js"
      );
      const report = await runSecurityAdversarialEval();
      process.stdout.write(formatSecurityAdversarialReport(report));
      return report.pass;
    };
    const runBranch = async () => {
      const { runBranchTruthEval, formatBranchTruthReport } = await import(
        "./eval/suites/branch-truth.js"
      );
      const r = runBranchTruthEval();
      process.stdout.write(formatBranchTruthReport(r));
      return r.pass;
    };
    const runTemporal = async () => {
      const { runTemporalCorrectnessEval, formatTemporalCorrectnessReport } = await import(
        "./eval/suites/temporal-correctness.js"
      );
      const r = await runTemporalCorrectnessEval();
      process.stdout.write(formatTemporalCorrectnessReport(r));
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
    const runProcedure = async (live = false) => {
      const { runProcedureMemoryEval, formatProcedureMemoryReport } = await import(
        "./eval/suites/procedure-memory.js"
      );
      const r = await runProcedureMemoryEval({ live, cwd: opts.cwd });
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
    const runStorage = async () => {
      const { runStorageMigrationsEval, formatStorageMigrationsReport } = await import(
        "./eval/suites/storage-migrations.js"
      );
      const r = runStorageMigrationsEval();
      process.stdout.write(formatStorageMigrationsReport(r));
      return r.pass;
    };
    const runTelemetry = async () => {
      const { runTelemetryLearningEval, formatTelemetryLearningReport } = await import(
        "./eval/suites/telemetry-learning.js"
      );
      const r = runTelemetryLearningEval();
      process.stdout.write(formatTelemetryLearningReport(r));
      return r.pass;
    };
    const runProvenance = async () => {
      const { runProvenanceWhyEval, formatProvenanceWhyReport } = await import(
        "./eval/suites/provenance-why.js"
      );
      const r = runProvenanceWhyEval();
      process.stdout.write(formatProvenanceWhyReport(r));
      return r.pass;
    };
    const runResilience = async () => {
      const { runResilienceFailsoftEval, formatResilienceFailsoftReport } = await import(
        "./eval/suites/resilience-failsoft.js"
      );
      const r = await runResilienceFailsoftEval();
      process.stdout.write(formatResilienceFailsoftReport(r));
      return r.pass;
    };
    const runBenchmarks = async () => {
      const { runEvalBenchmarksEval, formatEvalBenchmarksReport } = await import(
        "./eval/suites/eval-benchmarks.js"
      );
      const r = await runEvalBenchmarksEval();
      process.stdout.write(formatEvalBenchmarksReport(r));
      return r.pass;
    };
    const runCliDocsDemo = async () => {
      const { runCliDocsDemoEval, formatCliDocsDemoReport } = await import(
        "./eval/suites/cli-docs-demo.js"
      );
      const r = await runCliDocsDemoEval();
      process.stdout.write(formatCliDocsDemoReport(r));
      return r.pass;
    };
    const runQuality = async () => {
      const { runCodeQualityEval, formatCodeQualityReport } = await import(
        "./eval/suites/code-quality.js"
      );
      const r = runCodeQualityEval();
      process.stdout.write(formatCodeQualityReport(r));
      return r.pass;
    };

    const runners: Record<EvalGateSuite, () => Promise<boolean>> = {
      run: runArms,
      memory: runMemory,
      promote: runPromote,
      drift: runDrift,
      retrieval: runRetrieval,
      gate: runGate,
      security: runSecurity,
      branch: runBranch,
      temporal: runTemporal,
      conflict: runConflict,
      procedure: async () => {
        const live = Boolean(opts.live) && process.env.GRAPHCTX_LLM_LIVE === "1";
        if (opts.live && !live) {
          process.stdout.write("live procedure eval not run: set GRAPHCTX_LLM_LIVE=1 to opt in.\n");
        }
        return runProcedure(live);
      },
      mcp: runMcp,
      storage: runStorage,
      telemetry: runTelemetry,
      provenance: runProvenance,
      resilience: runResilience,
      benchmarks: runBenchmarks,
      "cli-docs-demo": runCliDocsDemo,
      quality: runQuality,
    };

    if (isEvalGateSuite(sub)) {
      if (!(await runners[sub]())) process.exitCode = 1;
      return;
    }
    if (sub === "all") {
      let pass = true;
      for (const suite of EVAL_GATE_SUITES) {
        pass = (await runners[suite]()) && pass;
      }
      if (!pass) process.exitCode = 1;
      return;
    }
    fail(`unknown eval subcommand "${sub}"`);
  });

// Extract the embedded sqlite-vec extension (compiled binary only; no-op under
// Node) before any command opens a DB, then dispatch.
void main();

// ---- helpers ----

async function main(): Promise<void> {
  try {
    bootstrapVec0();
    await program.parseAsync(process.argv);
  } catch (e) {
    handleCliError(e);
  }
}

function refreshAgentsCapsule(rt: Runtime): void {
  try {
    writeAgentsCapsule(rt);
  } catch (e) {
    logError(e);
  }
}

function resolveInstallBin(explicit?: string): string {
  if (explicit) return explicit;
  const argvScript = process.argv[1] ? resolve(process.argv[1]) : "";
  if (argvScript.endsWith("src/cli.ts")) return `npx tsx ${quote(argvScript)}`;
  if (argvScript.endsWith("dist/cli.js")) return `node ${quote(argvScript)}`;
  return "graphctx";
}

function installNextStep(client: string): string {
  switch (client) {
    case "claude":
      return "Claude Code hooks are installed; lifecycle push is active at SessionStart and PostCompact.";
    case "cursor":
      return "Cursor rule + MCP config installed; Cursor gets refreshed AGENTS.md grounding plus MCP recall.";
    case "opencode":
      return "OpenCode MCP config installed; OpenCode gets refreshed AGENTS.md grounding plus MCP recall.";
    case "codex":
      return "Codex MCP config written to ~/.codex/config.toml; restart any open Codex session to pick up the graphctx server.";
    default:
      return "Generic AGENTS.md grounding installed. Configure your client to run `graphctx serve --mcp` for recall.";
  }
}

// Detects whether graphctx is running from a development checkout (Node + tsx
// or `node dist/cli.js`) versus the shipped, self-contained Bun-compiled
// binary. Dev-only commands (demo / bench / eval / compare) need the source
// tree's fixtures and node_modules and MUST NOT be exposed in the binary.
function isDevelopmentCheckout(): boolean {
  // Bun sets process.versions.bun; the compiled single-file binary is a Bun
  // build, so this is the cleanest signal. Setting GRAPHCTX_DEV=1 forces dev
  // mode for tests/CI that run the binary against the source tree.
  if (process.env.GRAPHCTX_DEV === "1") return true;
  return !((process.versions as Record<string, string | undefined>).bun ?? "");
}

function requireDevCheckout(commandName: string): boolean {
  if (isDevelopmentCheckout()) return true;
  process.stderr.write(
    `error: \`graphctx ${commandName}\` is a development-only command and is not available in the shipped binary.\n       Clone https://github.com/coder-company/graphCTX and run it via \`npx tsx src/cli.ts\`.\n`,
  );
  process.exit(2);
}

interface AdapterReadiness {
  claude: boolean;
  cursor: boolean;
  opencode: boolean;
  codex: boolean;
  generic: boolean;
}

function adapterReadiness(workspaceDir: string): AdapterReadiness {
  return {
    claude: hasClaudeGraphctxHooks({ workspaceDir }),
    cursor: hasCursorGraphctxInstall(workspaceDir),
    opencode: hasOpenCodeGraphctxInstall(workspaceDir),
    codex: hasCodexGraphctxInstall(),
    generic: hasGenericGraphctxInstall(workspaceDir),
  };
}

function doctorVerdict(readiness: AdapterReadiness, factCount: number): string {
  if (factCount === 0) return "NOT READY ❌ — no facts yet; run `graphctx extract`.";
  if (readiness.claude) {
    return "READY ✅ — Claude Code hooks installed and memory populated; lifecycle push is live.";
  }
  if (readiness.cursor || readiness.opencode || readiness.codex) {
    return "READY ✅ — MCP recall and refreshed static grounding are installed; Claude-only lifecycle push is not active.";
  }
  if (readiness.generic) {
    return "READY ✅ — generic AGENTS.md grounding is installed; configure MCP or Claude hooks for live recall/push.";
  }
  return "NOT READY ❌ — run `graphctx install auto` to wire an adapter.";
}

function quote(path: string): string {
  return path.includes(" ") ? JSON.stringify(path) : path;
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

function parsePositiveIntegerOption(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    fail(`${flag} must be a positive integer`);
  }
  return n;
}

function parsePositiveNumberOption(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    fail(`${flag} must be a positive number`);
  }
  return n;
}

function parseFactKindOption(raw: string): FactKind {
  if ((FACT_KINDS as readonly string[]).includes(raw)) return raw as FactKind;
  fail(`--kind must be one of: ${FACT_KINDS.join(", ")}`);
}

function parseAsOfOption(raw?: string): string | undefined {
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) fail(`--at must be a valid ISO-8601 timestamp (got ${raw})`);
  return new Date(ms).toISOString();
}

const TUI_TABS = ["dashboard", "control", "monitor"] as const;
type TuiTab = (typeof TUI_TABS)[number];

function parseTuiTabOption(raw: string): TuiTab {
  if ((TUI_TABS as readonly string[]).includes(raw)) return raw as TuiTab;
  fail(`--tab must be one of: ${TUI_TABS.join(", ")}`);
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function handleCliError(e: unknown): never {
  if (e instanceof GraphCtxError) {
    process.stderr.write(`error: [${e.code}] ${e.message}\n`);
    if (e.action) process.stderr.write(`action: ${e.action}\n`);
  } else {
    const message = (e as Error)?.message ?? String(e);
    process.stderr.write(`error: ${message}\n`);
    if (process.env.GRAPHCTX_DEBUG_ERRORS === "1" && (e as Error)?.stack) {
      process.stderr.write(`${(e as Error).stack}\n`);
    }
  }
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

function exitOnBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });
}

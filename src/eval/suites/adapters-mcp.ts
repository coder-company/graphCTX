import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHookPayload, selectTier } from "../../adapters/channel.js";
import { handleHook } from "../../adapters/claude-code/hooks.js";
import { ProxyAdapter } from "../../adapters/proxy/index.js";
import { detectClient, makeAdapter } from "../../adapters/registry.js";
import type { Capsule, InjectionContext } from "../../core/types.js";
import { McpServer } from "../../mcp/server.js";
import { MCP_TOOLS } from "../../mcp/tools.js";
import type { Runtime } from "../../runtime.js";
import { classifyOutcome } from "../../telemetry/outcomes.js";

// Phase-4 (M4) gate suite. Verifies the multi-client surface:
//   1. install per client writes the right config (cursor rules+MCP, opencode MCP).
//   2. MCP server smoke: initialize + tools/list returns EXACTLY 8 tools (I8);
//      a tools/call round-trips.
//   3. generic adapter delivers via Tier 0 (AGENTS.md) + exposes a Tier 1 rider.
//   4. proxy is secure: refuses by default (opt-in) AND refuses secret capsules.
//   5. telemetry classifies outcomes (helped/ignored/harmful).
export interface AdaptersMcpReport {
  checks: number;
  passed: number;
  toolCount: number; // must be 8 (I8)
  proxyLeaks: number; // proxy injected a secret/while-disabled (want 0)
  detail: string[];
  pass: boolean;
}

export async function runAdaptersMcpEval(baseDir?: string): Promise<AdaptersMcpReport> {
  const detail: string[] = [];
  let passed = 0;
  let proxyLeaks = 0;
  const check = (name: string, ok: boolean) => {
    if (ok) passed += 1;
    detail.push(`${ok ? "✓" : "✗"} ${name}`);
  };

  const fixture = locateFixture(baseDir);

  // --- (1) install per client ---
  const cursorDir = mkdtempSync(join(tmpdir(), "gctx-cursor-"));
  const opencodeDir = mkdtempSync(join(tmpdir(), "gctx-opencode-"));
  const genericDir = mkdtempSync(join(tmpdir(), "gctx-generic-"));
  try {
    cpSync(fixture, cursorDir, { recursive: true });
    cpSync(fixture, opencodeDir, { recursive: true });
    cpSync(fixture, genericDir, { recursive: true });
    for (const d of [cursorDir, opencodeDir, genericDir]) {
      rmSync(join(d, ".graphctx"), { recursive: true, force: true });
    }

    const cursor = makeAdapter("cursor", cursorDir);
    await cursor.install({ workspaceDir: cursorDir, binPath: "graphctx" });
    check(
      "cursor install writes .cursor/rules + mcp.json",
      existsSync(join(cursorDir, ".cursor", "rules", "graphctx.mdc")) &&
        existsSync(join(cursorDir, ".cursor", "mcp.json")),
    );
    const cursorMcp = JSON.parse(readFileSync(join(cursorDir, ".cursor", "mcp.json"), "utf8"));
    check("cursor mcp.json registers graphctx server", !!cursorMcp.mcpServers?.graphctx);

    const opencode = makeAdapter("opencode", opencodeDir);
    await opencode.install({ workspaceDir: opencodeDir, binPath: "graphctx" });
    check(
      "opencode install writes opencode.json with mcp",
      existsSync(join(opencodeDir, "opencode.json")),
    );

    check("detectClient classifies cursor workspace", detectClient(cursorDir) === "cursor");
    check("detectClient classifies opencode workspace", detectClient(opencodeDir) === "opencode");
    const claudeDir = mkdtempSync(join(tmpdir(), "gctx-claude-"));
    try {
      cpSync(fixture, claudeDir, { recursive: true });
      rmSync(join(claudeDir, ".graphctx"), { recursive: true, force: true });
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(claudeDir, ".claude"), { recursive: true });
      writeFileSync(join(claudeDir, "CLAUDE.md"), "# Claude workspace\n", "utf8");
      check("detectClient classifies claude workspace", detectClient(claudeDir) === "claude");
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }

    // auto-detect falls back to generic on a bare repo
    check("detectClient falls back to generic", detectClient(genericDir) === "generic");

    // --- (3) generic Tier 0 + Tier 1 ---
    const generic = makeAdapter("generic", genericDir);
    const cap = await generic.detect();
    check("generic exposes Tier 0 + Tier 1", cap.tiers.includes(0) && cap.tiers.includes(1));
    const capsule: Capsule = {
      markdown: "- repo test_command: npm test [mem:abc]",
      cards: [{ fact_id: "abc", reason: "test", tokens: 8 }],
      omitted: [],
      conflicts: [],
      token_count: 8,
    };
    await generic.deliver(capsule, {} as never, 0);
    const agentsPath = join(genericDir, "AGENTS.md");
    const agents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
    check(
      "generic Tier 0 writes AGENTS.md",
      agents.includes("repo test_command: npm test") && !agents.includes("sk-"),
    );
    // @ts-expect-error rider is a GenericAdapter extra
    const rider: string = generic.rider(capsule);
    check("generic Tier 1 produces a bounded rider", rider.includes("graphCTX rider"));
    const hookPayload = JSON.parse(buildHookPayload("UserPromptSubmit", capsule)) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    check(
      "same capsule content delivered across Tier 0/1/2 transports",
      agents.includes("repo test_command: npm test") &&
        rider.includes(capsule.markdown) &&
        hookPayload.hookSpecificOutput?.additionalContext === capsule.markdown,
    );
    const ctx = { event: "UserPromptSubmit" } as InjectionContext;
    check("channel ladder selects highest supported tier", selectTier([0, 1, 2], ctx) === 2);
    check("hookless channel ladder falls back to Tier 1", selectTier(cap.tiers, ctx) === 1);

    // --- (4) proxy security ---
    const proxyDisabled = new ProxyAdapter(genericDir, { enabled: false });
    const capDisabled = await proxyDisabled.detect();
    check("proxy advertises NO tiers when disabled (opt-in)", capDisabled.tiers.length === 0);
    const rw1 = proxyDisabled.rewrite("do the thing", capsule);
    if (rw1.applied) proxyLeaks += 1;
    check("proxy refuses to rewrite while disabled", !rw1.applied);

    const proxyEnabled = new ProxyAdapter(genericDir, { enabled: true });
    const secretCapsule: Capsule = {
      markdown: "- repo deploy_token: sk-SECRETSECRETSECRETSECRET0001 [mem:x]",
      cards: [{ fact_id: "x", reason: "t", tokens: 8 }],
      omitted: [],
      conflicts: [],
      token_count: 8,
    };
    const rw2 = proxyEnabled.rewrite("do the thing", secretCapsule);
    if (rw2.applied) proxyLeaks += 1;
    check("proxy (enabled) refuses a capsule that trips the secret scanner (I3)", !rw2.applied);
    const rw3 = proxyEnabled.rewrite("do the thing", capsule);
    check(
      "proxy (enabled) rewrites a clean capsule",
      rw3.applied === true && !!rw3.augmentedPrompt,
    );
  } finally {
    for (const d of [cursorDir, opencodeDir, genericDir])
      rmSync(d, { recursive: true, force: true });
  }

  // --- (2) MCP smoke ---
  const mcpDir = mkdtempSync(join(tmpdir(), "gctx-mcp-"));
  let toolCount = 0;
  try {
    cpSync(fixture, mcpDir, { recursive: true });
    rmSync(join(mcpDir, ".graphctx"), { recursive: true, force: true });
    const server = new McpServer({ workspaceDir: mcpDir });
    try {
      const init = (await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" })) as {
        result?: { protocolVersion?: string };
      };
      check("MCP initialize returns protocol version", !!init.result?.protocolVersion);

      const list = (await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
        result?: { tools?: unknown[] };
      };
      toolCount = list.result?.tools?.length ?? 0;
      check(`MCP exposes EXACTLY 8 tools (I8) — got ${toolCount}`, toolCount === 8);

      // round-trip a remember then a recall
      const remembered = (await server.handle({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "remember",
          arguments: { text: "use vitest", subject: "repo", predicate: "test_runner" },
        },
      })) as { result?: { isError?: boolean } };
      check("MCP tools/call remember succeeds", remembered.result?.isError === false);

      const recalled = (await server.handle({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "recall", arguments: { query: "test runner" } },
      })) as { result?: { isError?: boolean; content?: unknown[] } };
      check("MCP tools/call recall returns content", recalled.result?.isError === false);

      const unknown = (await server.handle({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "does_not_exist", arguments: {} },
      })) as { error?: unknown };
      check("MCP rejects unknown tool", !!unknown.error);
    } finally {
      server.close();
    }
  } finally {
    rmSync(mcpDir, { recursive: true, force: true });
  }

  // also assert the static tool table is 8 (I8 invariant at module level)
  check("MCP_TOOLS table is exactly 8 (I8)", MCP_TOOLS.length === 8);

  // --- (2b) Claude hook Tier 2 payload + fail-soft ---
  const hookCapsule: Capsule = {
    markdown: "- repo test_command: npm test [mem:hook]",
    cards: [{ fact_id: "hook", reason: "test", tokens: 8 }],
    omitted: [],
    conflicts: [],
    token_count: 8,
  };
  const hookOk = await handleHook(fakeRuntime({ capsule: hookCapsule }), "UserPromptSubmit", {
    session_id: "s-hook",
    prompt: "run tests",
  });
  const hookJson = hookOk.stdout ? JSON.parse(hookOk.stdout) : {};
  check(
    "claude hook emits Tier 2 additionalContext payload",
    hookJson.hookSpecificOutput?.hookEventName === "UserPromptSubmit" &&
      hookJson.hookSpecificOutput?.additionalContext === hookCapsule.markdown,
  );
  const hookFail = await handleHook(fakeRuntime({ throwPlanning: true }), "UserPromptSubmit", {
    session_id: "s-hook",
    prompt: "run tests",
  });
  check(
    "claude hook degrades fail-soft to empty capsule on forced planner error",
    hookFail.stdout === "" &&
      hookFail.capsule.markdown === "" &&
      hookFail.capsule.cards.length === 0,
  );

  // --- (5) telemetry classification ---
  check(
    "telemetry classifies a repeated failure as harmful",
    classifyOutcome({ repeatedFailure: true }) === "harmful",
  );
  check(
    "telemetry classifies a downstream success as helped",
    classifyOutcome({ followedBySuccess: true }) === "helped",
  );
  check(
    "telemetry classifies no effect as ignored",
    classifyOutcome({ noEffect: true }) === "ignored",
  );

  const checks = detail.length;
  const pass = passed === checks && toolCount === 8 && proxyLeaks === 0;
  return { checks, passed, toolCount, proxyLeaks, detail, pass };
}

function fakeRuntime(opts: { capsule?: Capsule; throwPlanning?: boolean }): Runtime {
  return {
    workspaceId: "ws-eval",
    git: {
      async isRepo() {
        return false;
      },
    },
    episodeLog: {
      append() {},
    },
    async extract() {},
    async runPromotionSweep() {},
    async injectionContext(event: string) {
      return { event };
    },
    planner() {
      return {
        async plan() {
          if (opts.throwPlanning) throw new Error("forced planner failure");
          return (
            opts.capsule ?? { markdown: "", cards: [], omitted: [], conflicts: [], token_count: 0 }
          );
        },
      };
    },
  } as unknown as Runtime;
}

export function formatAdaptersMcpReport(r: AdaptersMcpReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval — adapters + MCP (M4 GATE)");
  lines.push("=".repeat(72));
  lines.push("");
  for (const d of r.detail) lines.push(`  ${d}`);
  lines.push("");
  lines.push(
    `  checks: ${r.passed}/${r.checks}   MCP tools: ${r.toolCount} (must be 8)   proxy leaks: ${r.proxyLeaks} (must be 0)`,
  );
  lines.push(
    r.pass
      ? "  VERDICT: ✅ M4 GATE PASS — multi-client install, MCP 8-tool surface, secure proxy, telemetry classifies."
      : "  VERDICT: ❌ M4 GATE FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function locateFixture(baseDir?: string): string {
  const roots = [
    baseDir ? join(baseDir, "fixtures") : null,
    join(process.cwd(), "fixtures"),
  ].filter(Boolean) as string[];
  for (const root of roots) {
    try {
      for (const entry of readdirSync(root)) {
        const dir = join(root, entry);
        if (existsSync(join(dir, "scenario.json"))) return dir;
      }
    } catch {
      // try next
    }
  }
  throw new Error("no fixture repo found for adapters-mcp eval");
}

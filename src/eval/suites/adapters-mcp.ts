import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHookPayload, selectTier } from "../../adapters/channel.js";
import { handleHook } from "../../adapters/claude-code/hooks.js";
import { hasClaudeGraphctxHooks } from "../../adapters/claude-code/install.js";
import { ProxyAdapter } from "../../adapters/proxy/index.js";
import { detectClient, makeAdapter } from "../../adapters/registry.js";
import type { Capsule, InjectionContext } from "../../core/types.js";
import { Git } from "../../git/git.js";
import { McpServer } from "../../mcp/server.js";
import { MCP_TOOLS } from "../../mcp/tools.js";
import type { Runtime } from "../../runtime.js";
import { classifyOutcome } from "../../telemetry/outcomes.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const tsxBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

const EXPECTED_MCP_TOOL_NAMES = [
  "remember",
  "recall",
  "inject_context",
  "checkpoint_session",
  "promote",
  "forget",
  "why",
  "resolve_conflict",
];

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "graphctx eval",
  GIT_AUTHOR_EMAIL: "eval@graphctx.local",
  GIT_COMMITTER_NAME: "graphctx eval",
  GIT_COMMITTER_EMAIL: "eval@graphctx.local",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00 +0000",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00 +0000",
};

// Phase-4 (M4) gate suite. Verifies the multi-client surface:
//   1. install per client writes the right config (cursor rules+MCP, opencode MCP).
//   2. MCP server contract: initialize + tools/list returns EXACTLY 8 tools (I8);
//      every tools/call validates inputs, returns structured output, and the real
//      serve --mcp stdio entry point speaks JSON-RPC.
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

    mkdirSync(join(cursorDir, ".cursor"), { recursive: true });
    writeFileSync(
      join(cursorDir, ".cursor", "mcp.json"),
      `${JSON.stringify({ mcpServers: { other: { command: "other-tool" } } }, null, 2)}\n`,
      "utf8",
    );

    const cursor = makeAdapter("cursor", cursorDir);
    await cursor.install({ workspaceDir: cursorDir, binPath: "graphctx" });
    check(
      "cursor install writes .cursor/rules + mcp.json",
      existsSync(join(cursorDir, ".cursor", "rules", "graphctx.mdc")) &&
        existsSync(join(cursorDir, ".cursor", "mcp.json")),
    );
    const cursorMcp = JSON.parse(readFileSync(join(cursorDir, ".cursor", "mcp.json"), "utf8"));
    check("cursor mcp.json registers graphctx server", !!cursorMcp.mcpServers?.graphctx);
    check(
      "cursor install preserves unrelated MCP servers",
      cursorMcp.mcpServers?.other?.command === "other-tool",
    );
    await cursor.uninstall();
    const cursorMcpAfterUninstall = JSON.parse(
      readFileSync(join(cursorDir, ".cursor", "mcp.json"), "utf8"),
    );
    check(
      "cursor uninstall removes graphctx rule/MCP entry without deleting unrelated MCP servers",
      !existsSync(join(cursorDir, ".cursor", "rules", "graphctx.mdc")) &&
        cursorMcpAfterUninstall.mcpServers?.graphctx === undefined &&
        cursorMcpAfterUninstall.mcpServers?.other?.command === "other-tool",
    );

    const badCursorDir = mkdtempSync(join(tmpdir(), "gctx-cursor-bad-"));
    try {
      cpSync(fixture, badCursorDir, { recursive: true });
      mkdirSync(join(badCursorDir, ".cursor"), { recursive: true });
      const badMcpPath = join(badCursorDir, ".cursor", "mcp.json");
      const badMcp = "{ not json";
      writeFileSync(badMcpPath, badMcp, "utf8");
      let threw = false;
      try {
        await makeAdapter("cursor", badCursorDir).install({
          workspaceDir: badCursorDir,
          binPath: "graphctx",
        });
      } catch {
        threw = true;
      }
      check(
        "cursor install refuses malformed existing mcp.json without overwriting it or writing partial rules",
        threw &&
          readFileSync(badMcpPath, "utf8") === badMcp &&
          !existsSync(join(badCursorDir, ".cursor", "rules", "graphctx.mdc")),
      );
    } finally {
      rmSync(badCursorDir, { recursive: true, force: true });
    }

    const badCursorUninstallDir = mkdtempSync(join(tmpdir(), "gctx-cursor-uninstall-bad-"));
    try {
      cpSync(fixture, badCursorUninstallDir, { recursive: true });
      const cursorRuleDir = join(badCursorUninstallDir, ".cursor", "rules");
      mkdirSync(cursorRuleDir, { recursive: true });
      const badMcpPath = join(badCursorUninstallDir, ".cursor", "mcp.json");
      const badMcp = "{ not json";
      writeFileSync(join(cursorRuleDir, "graphctx.mdc"), "graphctx rule\n", "utf8");
      writeFileSync(badMcpPath, badMcp, "utf8");
      let threw = false;
      try {
        await makeAdapter("cursor", badCursorUninstallDir).uninstall();
      } catch {
        threw = true;
      }
      check(
        "cursor uninstall refuses malformed mcp.json without removing partial config",
        threw &&
          readFileSync(badMcpPath, "utf8") === badMcp &&
          existsSync(join(cursorRuleDir, "graphctx.mdc")),
      );
    } finally {
      rmSync(badCursorUninstallDir, { recursive: true, force: true });
    }

    const symlinkCursorDir = mkdtempSync(join(tmpdir(), "gctx-cursor-symlink-"));
    const outsideCursorDir = mkdtempSync(join(tmpdir(), "gctx-cursor-outside-"));
    try {
      cpSync(fixture, symlinkCursorDir, { recursive: true });
      mkdirSync(join(symlinkCursorDir, ".cursor"), { recursive: true });
      const outsideMcpPath = join(outsideCursorDir, "mcp.json");
      const outsideMcp = `${JSON.stringify({ mcpServers: { other: { command: "outside" } } }, null, 2)}\n`;
      writeFileSync(outsideMcpPath, outsideMcp, "utf8");
      symlinkSync(outsideMcpPath, join(symlinkCursorDir, ".cursor", "mcp.json"), "file");

      let installThrew = false;
      try {
        await makeAdapter("cursor", symlinkCursorDir).install({
          workspaceDir: symlinkCursorDir,
          binPath: "graphctx",
        });
      } catch {
        installThrew = true;
      }
      check(
        "cursor install refuses symlinked mcp.json without modifying the target",
        installThrew &&
          readFileSync(outsideMcpPath, "utf8") === outsideMcp &&
          !existsSync(join(symlinkCursorDir, ".cursor", "rules", "graphctx.mdc")),
      );

      const ruleDir = join(symlinkCursorDir, ".cursor", "rules");
      mkdirSync(ruleDir, { recursive: true });
      writeFileSync(join(ruleDir, "graphctx.mdc"), "graphctx rule\n", "utf8");
      let uninstallThrew = false;
      try {
        await makeAdapter("cursor", symlinkCursorDir).uninstall();
      } catch {
        uninstallThrew = true;
      }
      check(
        "cursor uninstall refuses symlinked mcp.json without modifying the target",
        uninstallThrew &&
          readFileSync(outsideMcpPath, "utf8") === outsideMcp &&
          existsSync(join(ruleDir, "graphctx.mdc")),
      );
    } finally {
      rmSync(symlinkCursorDir, { recursive: true, force: true });
      rmSync(outsideCursorDir, { recursive: true, force: true });
    }

    const opencode = makeAdapter("opencode", opencodeDir);
    await opencode.install({ workspaceDir: opencodeDir, binPath: "graphctx" });
    check(
      "opencode install writes opencode.json with mcp",
      existsSync(join(opencodeDir, "opencode.json")),
    );

    const badOpenCodeDir = mkdtempSync(join(tmpdir(), "gctx-opencode-bad-"));
    try {
      cpSync(fixture, badOpenCodeDir, { recursive: true });
      const badConfigPath = join(badOpenCodeDir, "opencode.json");
      const badConfig = "{ not json";
      writeFileSync(badConfigPath, badConfig, "utf8");
      let threw = false;
      try {
        await makeAdapter("opencode", badOpenCodeDir).install({
          workspaceDir: badOpenCodeDir,
          binPath: "graphctx",
        });
      } catch {
        threw = true;
      }
      check(
        "opencode install refuses malformed existing opencode.json without overwriting it",
        threw && readFileSync(badConfigPath, "utf8") === badConfig,
      );
    } finally {
      rmSync(badOpenCodeDir, { recursive: true, force: true });
    }

    const badOpenCodeUninstallDir = mkdtempSync(join(tmpdir(), "gctx-opencode-uninstall-bad-"));
    try {
      cpSync(fixture, badOpenCodeUninstallDir, { recursive: true });
      const badConfigPath = join(badOpenCodeUninstallDir, "opencode.json");
      const badConfig = "{ not json";
      writeFileSync(badConfigPath, badConfig, "utf8");
      let threw = false;
      try {
        await makeAdapter("opencode", badOpenCodeUninstallDir).uninstall();
      } catch {
        threw = true;
      }
      check(
        "opencode uninstall refuses malformed opencode.json without overwriting it",
        threw && readFileSync(badConfigPath, "utf8") === badConfig,
      );
    } finally {
      rmSync(badOpenCodeUninstallDir, { recursive: true, force: true });
    }

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
      const claude = makeAdapter(detectClient(claudeDir), claudeDir);
      const claudeCap = await claude.detect();
      await claude.install({ workspaceDir: claudeDir, binPath: "graphctx" });
      check(
        "detected claude adapter installs Tier 2 graphctx hooks",
        claude.id === "claude" &&
          claudeCap.tiers.includes(2) &&
          hasClaudeGraphctxHooks({ workspaceDir: claudeDir }),
      );
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }

    const badClaudeDir = mkdtempSync(join(tmpdir(), "gctx-claude-bad-"));
    try {
      cpSync(fixture, badClaudeDir, { recursive: true });
      const claudeConfigDir = join(badClaudeDir, ".claude");
      mkdirSync(claudeConfigDir, { recursive: true });
      const settingsPath = join(claudeConfigDir, "settings.json");
      const badSettings = "{ not json";
      writeFileSync(settingsPath, badSettings, "utf8");
      let installThrew = false;
      try {
        await makeAdapter("claude", badClaudeDir).install({
          workspaceDir: badClaudeDir,
          binPath: "graphctx",
        });
      } catch {
        installThrew = true;
      }
      check(
        "claude install refuses malformed settings.json without overwriting it",
        installThrew && readFileSync(settingsPath, "utf8") === badSettings,
      );

      let uninstallThrew = false;
      try {
        await makeAdapter("claude", badClaudeDir).uninstall();
      } catch {
        uninstallThrew = true;
      }
      check(
        "claude uninstall refuses malformed settings.json without overwriting it",
        uninstallThrew && readFileSync(settingsPath, "utf8") === badSettings,
      );
    } finally {
      rmSync(badClaudeDir, { recursive: true, force: true });
    }

    const symlinkClaudeDir = mkdtempSync(join(tmpdir(), "gctx-claude-symlink-"));
    const outsideClaudeDir = mkdtempSync(join(tmpdir(), "gctx-claude-outside-"));
    try {
      cpSync(fixture, symlinkClaudeDir, { recursive: true });
      const claudeConfigDir = join(symlinkClaudeDir, ".claude");
      mkdirSync(claudeConfigDir, { recursive: true });
      const outsideSettingsPath = join(outsideClaudeDir, "settings.json");
      const outsideSettings = `${JSON.stringify({ hooks: {} }, null, 2)}\n`;
      writeFileSync(outsideSettingsPath, outsideSettings, "utf8");
      symlinkSync(outsideSettingsPath, join(claudeConfigDir, "settings.json"), "file");

      let installThrew = false;
      try {
        await makeAdapter("claude", symlinkClaudeDir).install({
          workspaceDir: symlinkClaudeDir,
          binPath: "graphctx",
        });
      } catch {
        installThrew = true;
      }
      check(
        "claude install refuses symlinked settings.json without modifying the target",
        installThrew && readFileSync(outsideSettingsPath, "utf8") === outsideSettings,
      );

      let uninstallThrew = false;
      try {
        await makeAdapter("claude", symlinkClaudeDir).uninstall();
      } catch {
        uninstallThrew = true;
      }
      check(
        "claude uninstall refuses symlinked settings.json without modifying the target",
        uninstallThrew && readFileSync(outsideSettingsPath, "utf8") === outsideSettings,
      );
    } finally {
      rmSync(symlinkClaudeDir, { recursive: true, force: true });
      rmSync(outsideClaudeDir, { recursive: true, force: true });
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
    const secretFloorCapsule: Capsule = {
      markdown: "- repo api_key: FAKEsecret01234567890 [mem:secret]",
      cards: [{ fact_id: "secret", reason: "test", tokens: 8 }],
      omitted: [],
      conflicts: [],
      token_count: 8,
    };
    await generic.deliver(secretFloorCapsule, {} as never, 0);
    const agentsAfterSecret = readFileSync(agentsPath, "utf8");
    check(
      "static adapter floor refuses secret-scanner cards",
      !agentsAfterSecret.includes("FAKEsecret01234567890"),
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
    initGitRepo(mcpDir);
    const mcpGit = new Git(mcpDir);
    const expectedRepoId = await mcpGit.repoId();
    const expectedHead = await mcpGit.head();
    const expectedBranch = await mcpGit.branch();
    const server = new McpServer({ workspaceDir: mcpDir });
    try {
      const init = (await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" })) as {
        result?: {
          protocolVersion?: string;
          serverInfo?: { name?: string };
          capabilities?: { tools?: unknown };
        };
      };
      check("MCP initialize returns protocol version", !!init.result?.protocolVersion);
      check(
        "MCP initialize returns serverInfo + tools capability",
        init.result?.serverInfo?.name === "graphctx" && !!init.result?.capabilities?.tools,
      );

      const list = (await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
        result?: {
          tools?: Array<{
            name?: string;
            inputSchema?: Record<string, unknown>;
            outputSchema?: Record<string, unknown>;
          }>;
        };
      };
      toolCount = list.result?.tools?.length ?? 0;
      check(`MCP exposes EXACTLY 8 tools (I8) — got ${toolCount}`, toolCount === 8);
      const listedNames = list.result?.tools?.map((t) => t.name ?? "") ?? [];
      check(
        "MCP tools/list names match static MCP_TOOLS table",
        sameList(listedNames, toolNames()),
      );
      check(
        "MCP tools/list exposes declared input and output schemas",
        (list.result?.tools ?? []).every(
          (t) => t.inputSchema?.type === "object" && t.outputSchema?.type === "object",
        ),
      );
      const injectEventEnum = (inputProps("inject_context", list).event?.enum ?? []).map(String);
      check(
        `MCP inject_context advertises lifecycle-event enum (${injectEventEnum.length} events)`,
        injectEventEnum.includes("UserPromptSubmit") &&
          injectEventEnum.includes("PostCompact") &&
          injectEventEnum.includes("BranchSwitch") &&
          !injectEventEnum.includes("NotARealEvent"),
      );
      const rememberProps = inputProps("remember", list);
      const recallProps = inputProps("recall", list);
      const forgetProps = inputProps("forget", list);
      const whyProps = inputProps("why", list);
      const kindEnum = (rememberProps.kind?.enum ?? []).map(String);
      check(
        "MCP tools/list advertises zod-aligned scalar constraints",
        rememberProps.text?.minLength === 1 &&
          kindEnum.includes("open_loop") &&
          kindEnum.includes("procedural") &&
          recallProps.query?.minLength === 1 &&
          recallProps.budget_tokens?.type === "integer" &&
          recallProps.budget_tokens?.minimum === 1 &&
          forgetProps.fact_id?.minLength === 1 &&
          whyProps.fact_id?.minLength === 1,
      );

      // round-trip a remember then a recall
      let requestId = 3;
      const remembered = await callTool(server, requestId++, "remember", {
        text: "use vitest",
        subject: "repo",
        predicate: "test_runner",
      });
      const rememberedPayload = payloadObject(remembered);
      const rememberedFactId =
        typeof rememberedPayload?.fact_id === "string" ? rememberedPayload.fact_id : "";
      check(
        "MCP tools/call remember succeeds",
        remembered.result?.isError === false && isRememberPayload(rememberedPayload),
      );
      const agentsAfterRemember = existsSync(join(mcpDir, "AGENTS.md"))
        ? readFileSync(join(mcpDir, "AGENTS.md"), "utf8")
        : "";
      check(
        "MCP remember refreshes AGENTS.md static grounding",
        agentsAfterRemember.includes("use vitest"),
      );

      const secret = "sk-FAKEFAKEFAKEFAKEFAKE0123abcd";
      const rejectedSecret = await callTool(server, requestId++, "remember", {
        text: `deploy token ${secret}`,
        subject: "repo",
        predicate: "deploy_token",
      });
      check(
        "MCP remember refuses secret-bearing memory without echoing the secret",
        rejectedSecret.result?.isError === true &&
          JSON.stringify(rejectedSecret).includes("refusing to store secret-bearing memory") &&
          !JSON.stringify(rejectedSecret).includes(secret),
      );
      const metadataSecret = "Authorization: Bearer plainlowentropytoken123";
      const rejectedMetadataSecret = await callTool(server, requestId++, "remember", {
        text: "store safe guidance only",
        subject: metadataSecret,
        predicate: "note",
      });
      check(
        "MCP remember refuses secret-bearing metadata without echoing the secret",
        rejectedMetadataSecret.result?.isError === true &&
          JSON.stringify(rejectedMetadataSecret).includes(
            "refusing to store secret-bearing memory",
          ) &&
          !JSON.stringify(rejectedMetadataSecret).includes(metadataSecret),
      );
      const invalidSecretKind = await callTool(server, requestId++, "remember", {
        text: "store safe guidance only",
        kind: secret,
      });
      check(
        "MCP validation errors redact secret-shaped arguments",
        invalidSecretKind.result?.isError === true &&
          !JSON.stringify(invalidSecretKind).includes(secret),
      );

      const recalled = await callTool(server, requestId++, "recall", { query: "vitest" });
      const recalledPayload = payloadObject(recalled);
      check(
        "MCP tools/call recall returns content",
        recalled.result?.isError === false &&
          isRecallPayload(recalledPayload) &&
          recalledPayload.cards.length > 0 &&
          recalledPayload.markdown.includes("vitest"),
      );
      const sessionSecret = "Authorization: Bearer plainlowentropytoken123";
      const rejectedSessionRecall = await callTool(server, requestId++, "recall", {
        query: "vitest",
        session_id: sessionSecret,
      });
      check(
        "MCP recall refuses secret-bearing session metadata without echoing the secret",
        rejectedSessionRecall.result?.isError === true &&
          JSON.stringify(rejectedSessionRecall).includes(
            "refusing to store secret-bearing memory",
          ) &&
          !JSON.stringify(rejectedSessionRecall).includes(sessionSecret),
      );

      const unknown = await callTool(server, requestId++, "does_not_exist", {});
      check("MCP rejects unknown tool", unknown.error?.code === -32602);
      const unknownSecretTool = await callTool(server, requestId++, secret, {});
      check(
        "MCP JSON-RPC errors redact secret-shaped tool names",
        unknownSecretTool.error?.code === -32602 &&
          !JSON.stringify(unknownSecretTool).includes(secret),
      );
      const forgetMissing = await callTool(server, requestId++, "forget", {
        fact_id: "DOESNOTEXIST",
      });
      check("MCP forget rejects a missing fact", forgetMissing.result?.isError === true);
      const whySuffix = await callTool(server, requestId++, "why", {
        fact_id: rememberedFactId.slice(-8),
      });
      const whyPayload = payloadObject(whySuffix);
      const rememberedAnchor = isRecord(whyPayload?.git_anchor) ? whyPayload.git_anchor : null;
      check(
        "MCP why accepts a last-8 fact id suffix",
        whySuffix.result?.isError === false && isRecord(whyPayload?.fact),
      );
      check(
        "MCP remember stamps current git repo/head/branch anchor",
        rememberedAnchor?.repo_id === expectedRepoId &&
          rememberedAnchor.valid_from_commit === expectedHead &&
          rememberedAnchor.introduced_by_commit === expectedHead &&
          rememberedAnchor.branch === expectedBranch,
      );

      const badMethod = (await server.handle({
        jsonrpc: "2.0",
        id: requestId++,
        method: "not/a_method",
      })) as { error?: { code?: number } };
      check("MCP rejects invalid method with -32601", badMethod.error?.code === -32601);

      const toolCases = mcpToolCases(rememberedFactId);
      for (const tc of toolCases) {
        const valid = await callTool(server, requestId++, tc.name, tc.valid);
        const payload = payloadObject(valid);
        check(
          `MCP input contract: ${tc.name} valid succeeds / invalid rejects`,
          valid.result?.isError === false &&
            (await callTool(server, requestId++, tc.name, tc.invalid)).result?.isError === true,
        );
        check(`MCP output shape: ${tc.name}`, valid.result?.isError === false && tc.shape(payload));
      }

      const riderFirst = await callTool(server, requestId++, "remember", {
        text: "mcp rider eval fact for deterministic context",
        subject: "repo",
        predicate: "mcp rider",
      });
      const firstRider = riderText(riderFirst);
      check(
        "MCP Tier-1 rider is bounded by 600 chars",
        firstRider.includes("graphCTX rider") && firstRider.length <= 600,
      );
      const riderSecond = await callTool(server, requestId++, "recall", { query: "mcp rider" });
      const secondRider = riderText(riderSecond);
      check(
        "MCP Tier-1 rider anti-repetition suppresses repeat within session TTL",
        !secondRider.includes("mcp rider eval fact") && secondRider.length <= 600,
      );
    } finally {
      server.close();
    }

    const stdio = runServeMcpStdio(mcpDir);
    check("MCP serve --mcp stdio initialize returns protocol version", stdio.initialized);
    check(
      `MCP serve --mcp stdio tools/list returns 8 tools (${stdio.toolNames.join(", ")})`,
      stdio.toolNames.length === 8 && sameList(stdio.toolNames, EXPECTED_MCP_TOOL_NAMES),
    );
  } finally {
    rmSync(mcpDir, { recursive: true, force: true });
  }

  // also assert the static tool table is 8 (I8 invariant at module level)
  check("MCP_TOOLS table is exactly 8 (I8)", MCP_TOOLS.length === 8);
  check(
    "MCP_TOOLS table names are the documented 8",
    sameList(toolNames(), EXPECTED_MCP_TOOL_NAMES),
  );
  check("MCP server hard-errors on tool count drift", rejectsToolCountDrift());

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
    "telemetry precedence: harmful wins over helped signals",
    classifyOutcome({
      repeatedFailure: true,
      followedBySuccess: true,
      referencedInjectedFact: true,
    }) === "harmful",
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

interface ToolCallResponse {
  result?: {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
  };
  error?: { code?: number; message?: string };
}

interface ToolContractCase {
  name: string;
  valid: unknown;
  invalid: unknown;
  shape: (payload: Record<string, unknown> | null) => boolean;
}

async function callTool(
  server: McpServer,
  id: number,
  name: string,
  args: unknown,
): Promise<ToolCallResponse> {
  return (await server.handle({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  })) as ToolCallResponse;
}

function mcpToolCases(factId: string): ToolContractCase[] {
  return [
    {
      name: "remember",
      valid: { text: "use pnpm", subject: "repo", predicate: "package_manager" },
      invalid: {},
      shape: isRememberPayload,
    },
    {
      name: "recall",
      valid: { query: "pnpm" },
      invalid: {},
      shape: isRecallPayload,
    },
    {
      name: "inject_context",
      valid: { event: "UserPromptSubmit", session_id: "mcp-contract", user_prompt: "pnpm" },
      invalid: { event: "NotARealEvent" },
      shape: isRecallPayload,
    },
    {
      name: "checkpoint_session",
      valid: { session_id: "mcp-contract" },
      invalid: { session_id: 42 },
      shape: (p) => isRecord(p?.promoted),
    },
    {
      name: "promote",
      valid: { session_id: "mcp-contract", dry_run: true },
      invalid: { dry_run: "true" },
      shape: (p) => p?.dry_run === true && typeof p.candidate_count === "number",
    },
    {
      name: "why",
      valid: { fact_id: factId },
      invalid: { fact_id: "" },
      shape: (p) => isRecord(p?.fact) || p?.error === "fact not found",
    },
    {
      name: "forget",
      valid: { fact_id: factId, reason: "mcp contract eval" },
      invalid: { fact_id: "" },
      shape: (p) => p?.fact_id === factId && p?.status === "expired",
    },
    {
      name: "resolve_conflict",
      valid: { session_id: "mcp-contract" },
      invalid: { session_id: 42 },
      shape: (p) => Array.isArray(p?.winners) && Array.isArray(p?.conflicts),
    },
  ];
}

function inputProps(
  name: string,
  list: {
    result?: {
      tools?: Array<{
        name?: string;
        inputSchema?: { properties?: Record<string, SchemaProp> };
      }>;
    };
  },
): Record<string, SchemaProp> {
  return list.result?.tools?.find((t) => t.name === name)?.inputSchema?.properties ?? {};
}

interface SchemaProp {
  type?: unknown;
  enum?: unknown[];
  minLength?: unknown;
  minimum?: unknown;
}

function payloadObject(res: ToolCallResponse): Record<string, unknown> | null {
  if (isRecord(res.result?.structuredContent)) return res.result.structuredContent;
  const first = res.result?.content?.find((c) => c.type === "text" && c.text)?.text;
  if (!first) return null;
  try {
    const parsed = JSON.parse(first);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function riderText(res: ToolCallResponse): string {
  return (res.result?.content ?? [])
    .slice(1)
    .map((c) => c.text ?? "")
    .join("\n");
}

function isRememberPayload(p: Record<string, unknown> | null): p is {
  fact_id: string;
  status: string;
} {
  return typeof p?.fact_id === "string" && typeof p.status === "string";
}

function isRecallPayload(p: Record<string, unknown> | null): p is {
  markdown: string;
  cards: unknown[];
  tokens: number;
} {
  return typeof p?.markdown === "string" && Array.isArray(p.cards) && typeof p.tokens === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function toolNames(): string[] {
  return MCP_TOOLS.map((t) => t.name);
}

function rejectsToolCountDrift(): boolean {
  const originalLength = MCP_TOOLS.length;
  MCP_TOOLS.push({
    name: "drift_probe",
    description: "temporary eval probe",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    async handler() {
      return {};
    },
  });
  try {
    const server = new McpServer();
    server.close();
    return false;
  } catch (e) {
    return (e as Error).message.includes("I8 violation");
  } finally {
    MCP_TOOLS.splice(originalLength);
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

function runServeMcpStdio(workspaceDir: string): { initialized: boolean; toolNames: string[] } {
  try {
    execFileSync("git", ["-C", workspaceDir, "init", "-q"], { stdio: "ignore" });
    const stdout = execFileSync(tsxBin, [cliPath, "serve", "--mcp", "-C", workspaceDir], {
      cwd: repoRoot,
      env: { ...process.env, GRAPHCTX_USER_ID: "mcp-stdio-eval" },
      input: [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        "",
      ].join("\n"),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 20000,
    });
    const responses = stdout
      .trim()
      .split(/\n+/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const init = responses.find((r) => r.id === 1);
    const list = responses.find((r) => r.id === 2);
    const initResult = isRecord(init?.result) ? init.result : null;
    const listResult = isRecord(list?.result) ? list.result : null;
    const initialized =
      typeof initResult?.protocolVersion === "string" && initResult.protocolVersion.length > 0;
    const tools = Array.isArray(listResult?.tools) ? listResult.tools : [];
    const names = tools
      .map((t) => (isRecord(t) && typeof t.name === "string" ? t.name : ""))
      .filter(Boolean);
    return { initialized, toolNames: names };
  } catch {
    return { initialized: false, toolNames: [] };
  }
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

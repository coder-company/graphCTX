import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter, hasCodexGraphctxInstall } from "../../src/adapters/codex/index.js";

let workDir: string;
let homeDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "gctx-codex-work-"));
  homeDir = mkdtempSync(join(tmpdir(), "gctx-codex-home-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe("codex adapter", () => {
  it("creates ~/.codex/config.toml with an [mcp_servers.graphctx] block on first install", async () => {
    const adapter = new CodexAdapter(workDir, homeDir);
    await adapter.install({ workspaceDir: workDir, binPath: "graphctx" });
    const cfgPath = join(homeDir, ".codex", "config.toml");
    expect(existsSync(cfgPath)).toBe(true);
    const text = readFileSync(cfgPath, "utf8");
    expect(text).toContain("[mcp_servers.graphctx]");
    expect(text).toContain('command = "graphctx"');
    expect(text).toContain('args = ["serve", "--mcp"]');
    expect(hasCodexGraphctxInstall(homeDir)).toBe(true);
  });

  it("preserves the user's existing config and other MCP servers", async () => {
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    const existing = [
      'model = "gpt-5"',
      'approval_policy = "never"',
      "",
      "[mcp_servers.exa]",
      'url = "https://mcp.exa.ai/mcp"',
      "",
    ].join("\n");
    writeFileSync(join(homeDir, ".codex", "config.toml"), existing, "utf8");

    await new CodexAdapter(workDir, homeDir).install({
      workspaceDir: workDir,
      binPath: "graphctx",
    });

    const result = readFileSync(join(homeDir, ".codex", "config.toml"), "utf8");
    expect(result).toContain('model = "gpt-5"');
    expect(result).toContain('approval_policy = "never"');
    expect(result).toContain("[mcp_servers.exa]");
    expect(result).toContain('url = "https://mcp.exa.ai/mcp"');
    expect(result).toContain("[mcp_servers.graphctx]");
  });

  it("is idempotent: a second install replaces the previous block, not duplicates it", async () => {
    const adapter = new CodexAdapter(workDir, homeDir);
    await adapter.install({ workspaceDir: workDir, binPath: "graphctx" });
    await adapter.install({ workspaceDir: workDir, binPath: "/abs/path/to/graphctx" });
    const text = readFileSync(join(homeDir, ".codex", "config.toml"), "utf8");
    const headers = text.match(/^\[mcp_servers\.graphctx\]/gm) ?? [];
    expect(headers).toHaveLength(1);
    expect(text).toContain('command = "/abs/path/to/graphctx"');
  });

  it("uninstall removes the graphctx block and leaves other config intact", async () => {
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    const existing = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.exa]",
      'url = "https://mcp.exa.ai/mcp"',
      "",
    ].join("\n");
    writeFileSync(join(homeDir, ".codex", "config.toml"), existing, "utf8");

    const adapter = new CodexAdapter(workDir, homeDir);
    await adapter.install({ workspaceDir: workDir, binPath: "graphctx" });
    expect(hasCodexGraphctxInstall(homeDir)).toBe(true);

    await adapter.uninstall();
    expect(hasCodexGraphctxInstall(homeDir)).toBe(false);

    const text = readFileSync(join(homeDir, ".codex", "config.toml"), "utf8");
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain("[mcp_servers.exa]");
    expect(text).not.toContain("[mcp_servers.graphctx]");
  });

  it("uninstall on a fresh home is a no-op", async () => {
    await new CodexAdapter(workDir, homeDir).uninstall();
    expect(existsSync(join(homeDir, ".codex", "config.toml"))).toBe(false);
  });

  it("detect reports Tier 0 + Tier 1 capability", async () => {
    const cap = await new CodexAdapter(workDir, homeDir).detect();
    expect(cap.tiers).toEqual([0, 1]);
    expect(cap.highest).toBe(1);
  });
});

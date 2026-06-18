import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../../src/runtime.js";

describe("Runtime injection context sanitization", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "graphctx-runtime-context-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("redacts secret-bearing prompt, transcript, entity, tool, and result text", async () => {
    const secret = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
    const rt = new Runtime({ workspaceDir: dir, userId: "u" });
    const ctx = await rt.injectionContext("PreToolUse", "s", {
      user_prompt: `prompt ${secret}`,
      transcript_tail: `tail ${secret}`,
      current_files: [`src/${secret}.ts`],
      mentioned_symbols: [`symbol_${secret}`],
      planned_tool: {
        name: "Bash",
        args: {
          command: `curl -H 'Authorization: Bearer ${secret}' https://example.invalid`,
        },
      },
      tool_result: {
        success: false,
        stderr: `stderr ${secret}`,
        stdout_tail: `stdout ${secret}`,
      },
    });
    rt.close();

    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED:");
  });

  it("hard-caps long prompt and tool-result text at the runtime interface", async () => {
    const rt = new Runtime({ workspaceDir: dir, userId: "u" });
    const ctx = await rt.injectionContext("PostToolUse", "s", {
      user_prompt: "p".repeat(5000),
      tool_result: {
        success: false,
        stderr: "e".repeat(1500),
        stdout_tail: "o".repeat(1500),
      },
    });
    rt.close();

    expect(ctx.user_prompt).toHaveLength(4000);
    expect(ctx.tool_result?.stderr).toHaveLength(1000);
    expect(ctx.tool_result?.stdout_tail).toHaveLength(1000);
  });
});

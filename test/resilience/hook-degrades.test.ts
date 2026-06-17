import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleHook } from "../../src/adapters/claude-code/hooks.js";
import { Runtime } from "../../src/runtime.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cliPath = join(repoRoot, "src", "cli.ts");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gctx-res-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Run the REAL entry point the client uses: `graphctx hook <event>`. We assert
// the process exits 0 and prints nothing (no memory) under broken conditions —
// I9: a broken graphCTX must degrade to no memory, never a broken agent.
function runHook(event: string, payload: object): { status: number; stdout: string } {
  try {
    const stdout = execFileSync("npx", ["tsx", cliPath, "hook", event, "-C", dir], {
      input: JSON.stringify(payload),
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 30000,
    });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "" };
  }
}

describe("I9 resilience — agent still runs when graphCTX is broken", () => {
  it("corrupt workspace DB → exit 0, no output", () => {
    mkdirSync(join(dir, ".graphctx"), { recursive: true });
    // Write garbage where the SQLite file is expected.
    writeFileSync(join(dir, ".graphctx", "workspace.db"), "this is not a sqlite database");
    const res = runHook("PostCompact", { session_id: "s", cwd: dir });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
  }, 40000);

  it("invalid config JSON → exit 0, no output", () => {
    mkdirSync(join(dir, ".graphctx"), { recursive: true });
    writeFileSync(join(dir, ".graphctx", "config.json"), "{ this is not valid json ,,, }");
    const res = runHook("SessionStart", { session_id: "s", cwd: dir });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
  }, 40000);

  it("schema-invalid config → exit 0, no output", () => {
    mkdirSync(join(dir, ".graphctx"), { recursive: true });
    writeFileSync(
      join(dir, ".graphctx", "config.json"),
      JSON.stringify({ inject: { total_budget_tokens: -999, max_cards: "lots" } }),
    );
    const res = runHook("PostCompact", { session_id: "s", cwd: dir });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
  }, 40000);

  it("missing git (non-repo dir) → handleHook does not throw, capsule is well-formed", async () => {
    // dir is a fresh tmp with no .git — git ops must degrade, not throw.
    const rt = new Runtime({ workspaceDir: dir, userId: "u" });
    const result = await handleHook(rt, "PostCompact", { session_id: "s", cwd: dir });
    rt.close();
    expect(result.capsule).toBeDefined();
    expect(typeof result.stdout).toBe("string");
  });

  it("planner failure mid-hook → empty capsule, never throws", async () => {
    const rt = new Runtime({ workspaceDir: dir, userId: "u" });
    // Force a failure deep in the inject path by making planner() blow up.
    rt.planner = () => {
      throw new Error("simulated retrieval/render crash");
    };
    const result = await handleHook(rt, "PostCompact", { session_id: "s", cwd: dir });
    rt.close();
    expect(result.stdout).toBe("");
    expect(result.capsule.markdown).toBe("");
    expect(result.capsule.cards).toHaveLength(0);
  });

  it("secret-bearing hook payloads are redacted before episode persistence", async () => {
    const secret = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
    const rt = new Runtime({ workspaceDir: dir, userId: "u" });
    await handleHook(rt, "UserPromptSubmit", {
      session_id: "s-redact",
      cwd: dir,
      prompt: `deploy using token ${secret}`,
      tool_name: "Bash",
      tool_input: {
        command: `curl -H 'Authorization: Bearer ${secret}' https://example.invalid`,
        env: { GITHUB_TOKEN: secret },
      },
      tool_response: {
        success: false,
        stderr: `failed with ${secret}`,
        stdout: `not captured ${secret}`,
      },
    });
    const stored = JSON.stringify(rt.episodes.bySession("s-redact").map((e) => e.payload));
    rt.close();

    expect(stored).not.toContain(secret);
    expect(stored).toContain("[REDACTED:");
  });

  it("secret-bearing hook session ids are replaced before episode persistence", async () => {
    const sessionSecret = "Authorization: Bearer plainlowentropytoken123";
    const rt = new Runtime({ workspaceDir: dir, userId: "u" });
    await handleHook(rt, "UserPromptSubmit", {
      session_id: sessionSecret,
      cwd: dir,
      prompt: "continue the task",
    });
    const leakedRows = rt.episodes.bySession(sessionSecret);
    const redactedRows = rt.episodes.bySession("redacted-session");
    rt.close();

    expect(leakedRows).toHaveLength(0);
    expect(redactedRows).toHaveLength(1);
    expect(JSON.stringify(redactedRows)).not.toContain(sessionSecret);
  });
});

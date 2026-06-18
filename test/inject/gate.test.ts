import { describe, expect, it } from "vitest";
import type { InjectionContext } from "../../src/core/types.js";
import { shouldFire } from "../../src/inject/gate.js";

const cfg = {
  enabledEvents: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostCompact"],
  driftThreshold: 0.35,
};

function ctx(p: Partial<InjectionContext>): InjectionContext {
  return {
    event: "SessionStart",
    scope: { user_id: "u", workspace_id: "w", session_id: "s" },
    git: { repo_id: "w", head: "h", branch: "main" },
    ...p,
  };
}

describe("relevance gate (M0)", () => {
  it("SessionStart always fires", () => {
    expect(shouldFire(ctx({ event: "SessionStart" }), cfg)).toBe(true);
  });

  it("PostCompact always fires (beachhead)", () => {
    expect(shouldFire(ctx({ event: "PostCompact" }), cfg)).toBe(true);
  });

  it("UserPromptSubmit fires only with new entities", () => {
    expect(shouldFire(ctx({ event: "UserPromptSubmit" }), cfg)).toBe(false);
    expect(shouldFire(ctx({ event: "UserPromptSubmit", current_files: ["src/a.ts"] }), cfg)).toBe(
      true,
    );
  });

  it("PreToolUse fires only for memory-relevant tools with concrete args", () => {
    // Bash with an actual command → fire (we may have facts about it).
    expect(
      shouldFire(
        ctx({ event: "PreToolUse", planned_tool: { name: "Bash", args: { command: "npm test" } } }),
        cfg,
      ),
    ).toBe(true);
    // Python project commands are also memory-relevant guardrail moments.
    for (const command of [
      "uv run pytest",
      "poetry run ruff check .",
      "pip install -r requirements.txt",
    ]) {
      expect(
        shouldFire(
          ctx({ event: "PreToolUse", planned_tool: { name: "Bash", args: { command } } }),
          cfg,
        ),
      ).toBe(true);
    }
    // Edit on a concrete path → fire (path may carry constraints).
    expect(
      shouldFire(
        ctx({
          event: "PreToolUse",
          planned_tool: { name: "Edit", args: { file_path: "src/a.ts" } },
        }),
        cfg,
      ),
    ).toBe(true);
    // Irrelevant tool → never fire.
    expect(shouldFire(ctx({ event: "PreToolUse", planned_tool: { name: "WebSearch" } }), cfg)).toBe(
      false,
    );
    // Bare Bash with no args → not actionable → don't fire (M2 selectivity).
    expect(shouldFire(ctx({ event: "PreToolUse", planned_tool: { name: "Bash" } }), cfg)).toBe(
      false,
    );
    // Harmless shell commands with no repo-memory or safety relevance stay quiet.
    expect(
      shouldFire(
        ctx({ event: "PreToolUse", planned_tool: { name: "Bash", args: { command: "echo ok" } } }),
        cfg,
      ),
    ).toBe(false);
  });

  it("disabled events never fire", () => {
    expect(shouldFire(ctx({ event: "PostToolUse" }), cfg)).toBe(false);
  });
});

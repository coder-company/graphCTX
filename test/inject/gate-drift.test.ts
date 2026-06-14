import { describe, expect, it } from "vitest";
import type { InjectionContext } from "../../src/core/types.js";
import { cosineDistance, shouldFire, taskCentroid } from "../../src/inject/gate.js";

const cfg = {
  enabledEvents: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostCompact"],
  driftThreshold: 0.35,
};

function ctx(p: Partial<InjectionContext>): InjectionContext {
  return {
    event: "UserPromptSubmit",
    scope: { user_id: "u", workspace_id: "w", session_id: "s" },
    git: { repo_id: "w", head: "h", branch: "main" },
    ...p,
  };
}

describe("relevance gate — drift signal (M2)", () => {
  it("fires on UserPromptSubmit when centroid drift exceeds threshold", () => {
    expect(shouldFire(ctx({}), cfg, { centroidDistance: 0.6 })).toBe(true);
  });

  it("does NOT fire when drift is below threshold and no new entities", () => {
    expect(shouldFire(ctx({}), cfg, { centroidDistance: 0.1, hasNewEntities: false })).toBe(false);
  });

  it("fires on new entities even when drift is low", () => {
    expect(shouldFire(ctx({}), cfg, { centroidDistance: 0.1, hasNewEntities: true })).toBe(true);
  });

  it("falls back to entity-presence when no drift signal is available", () => {
    expect(shouldFire(ctx({ current_files: ["src/a.ts"] }), cfg, undefined)).toBe(true);
    expect(shouldFire(ctx({}), cfg, undefined)).toBe(false);
  });

  it("PostToolUse fires only on failure", () => {
    expect(shouldFire(ctx({ event: "PostToolUse", tool_result: { success: false } }), cfg)).toBe(
      true,
    );
    expect(shouldFire(ctx({ event: "PostToolUse", tool_result: { success: true } }), cfg)).toBe(
      false,
    );
  });
});

describe("drift math", () => {
  it("cosineDistance is 0 for identical vectors, ~2 for opposite", () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([1, 0, 0]);
    const c = Float32Array.from([-1, 0, 0]);
    expect(cosineDistance(a, b)).toBeCloseTo(0, 5);
    expect(cosineDistance(a, c)).toBeCloseTo(2, 5);
  });

  it("taskCentroid averages and re-normalizes", () => {
    const v = taskCentroid([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
    expect(v).not.toBeNull();
    const norm = Math.sqrt((v![0] ?? 0) ** 2 + (v![1] ?? 0) ** 2);
    expect(norm).toBeCloseTo(1, 5);
  });

  it("taskCentroid returns null for empty input", () => {
    expect(taskCentroid([])).toBeNull();
  });
});

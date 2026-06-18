import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../src/core/clock.js";
import { Runtime } from "../../src/runtime.js";

describe("Runtime promotion review", () => {
  let dir: string;
  let rt: Runtime;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "graphctx-runtime-promote-"));
    rt = new Runtime({
      workspaceDir: dir,
      userId: "u",
      clock: fixedClock("2026-06-02T03:04:05.000Z"),
    });
  });

  afterEach(() => {
    rt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies promotion gates instead of blindly activating selected facts", async () => {
    const promotable = rt.facts.insert({
      subject: "repo",
      predicate: "test_command",
      object: "npm test",
      fact_kind: "procedural",
      temporal_kind: "static",
      scope: rt.scope("s1"),
      trust_tier: "high",
      status: "candidate",
      promotion_state: "session_only",
      source: { asserted_by: "deterministic_parser", event_ids: [] },
      tags: [],
    });
    const secret = rt.facts.insert({
      subject: "repo",
      predicate: "api_key",
      object: "sk-FAKEFAKEFAKEFAKEFAKE0123abcd",
      fact_kind: "decision",
      temporal_kind: "static",
      scope: rt.scope("s1"),
      trust_tier: "high",
      status: "candidate",
      promotion_state: "session_only",
      source: { asserted_by: "user", event_ids: [] },
      tags: ["repo"],
    });

    const promoted = await rt.reviewFactForWorkspace(promotable.fact_id);
    const rejected = await rt.reviewFactForWorkspace(secret.fact_id);

    expect(promoted?.decision).toMatchObject({ kind: "promote", gate: "config_evidence" });
    expect(rt.facts.get(promotable.fact_id)).toMatchObject({
      status: "active",
      promotion_state: "workspace_active",
      last_verified_at: "2026-06-02T03:04:05.000Z",
    });
    expect(rejected?.decision).toMatchObject({ kind: "reject", gate: "secret" });
    expect(rt.facts.get(secret.fact_id)).toMatchObject({
      status: "candidate",
      promotion_state: "session_only",
    });
    expect(rt.promotions.forFact(promotable.fact_id)[0]?.decision).toBe("promote");
    expect(rt.promotions.forFact(secret.fact_id)[0]?.decision).toBe("reject");
  });
});

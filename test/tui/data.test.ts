import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../../src/runtime.js";
import { factViews, memoryStats } from "../../src/tui/data.js";

describe("tui/data — memory stats from a live runtime", () => {
  let dir: string;
  let rt: Runtime;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "graphctx-tui-"));
    rt = new Runtime({ workspaceDir: dir });
  });

  afterEach(() => {
    rt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts facts by status, scope, and kind", () => {
    rt.facts.insert({
      subject: "repo",
      predicate: "note",
      object: "use pnpm",
      fact_kind: "decision",
      temporal_kind: "static",
      scope: { user_id: rt.userId, workspace_id: rt.workspaceId },
      trust_tier: "high",
      status: "active",
      promotion_state: "workspace_active",
      source: { asserted_by: "user", event_ids: [] },
      tags: [],
    });
    rt.noteOpenLoop("finish the retry backoff");

    const s = memoryStats(rt);
    expect(s.total).toBe(2);
    expect(s.active).toBe(2);
    expect(s.openLoops).toBe(1);
    expect(s.byScope.workspace).toBe(1);
    expect(s.byScope.session).toBe(1);
    expect(s.byTrust.high).toBe(2);
  });

  it("factViews maps scope label from promotion_state", () => {
    rt.facts.insert({
      subject: "repo",
      predicate: "note",
      object: "deploy with ship.sh",
      fact_kind: "decision",
      temporal_kind: "static",
      scope: { user_id: rt.userId, workspace_id: rt.workspaceId },
      trust_tier: "high",
      status: "active",
      promotion_state: "workspace_active",
      source: { asserted_by: "user", event_ids: [] },
      tags: [],
    });
    const views = factViews(rt);
    expect(views).toHaveLength(1);
    expect(views[0]?.scope).toBe("workspace");
    expect(views[0]?.text).toContain("ship.sh");
    expect(views[0]?.id8).toHaveLength(8);
  });

  it("empty workspace yields zeroed stats", () => {
    const s = memoryStats(rt);
    expect(s.total).toBe(0);
    expect(s.active).toBe(0);
    expect(s.openLoops).toBe(0);
  });
});

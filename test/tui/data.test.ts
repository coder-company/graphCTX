import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../../src/runtime.js";
import { visibleLen } from "../../src/tui/ansi.js";
import {
  TuiApp,
  clampTuiWidth,
  clampWindowStart,
  filterFactViews,
  renderFactList,
  renderPromptFooter,
  wrapFooterParts,
} from "../../src/tui/app.js";
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

  it("counts facts by status, scope, and kind", async () => {
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
    await rt.noteOpenLoop("finish the retry backoff");

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

  it("redacts secret-bearing fact text and omits unsafe cards", () => {
    const secret = "sk-FAKEFAKEFAKEFAKEFAKE0123abcd";
    rt.facts.insert({
      subject: `repo-${secret}`,
      predicate: `deploy_token_${secret}`,
      object: secret,
      fact_kind: "decision",
      temporal_kind: "static",
      scope: { user_id: rt.userId, workspace_id: rt.workspaceId },
      trust_tier: "high",
      status: "active",
      promotion_state: "workspace_active",
      source: { asserted_by: "user", event_ids: [], raw_quote: `token is ${secret}` },
      tags: [],
    });
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

    const views = factViews(rt);
    const renderedViews = JSON.stringify(views.map((view) => view.text));
    const cardList = renderFactList(rt);

    expect(memoryStats(rt).secrets).toBe(1);
    expect(renderedViews).not.toContain(secret);
    expect(renderedViews).toContain("[REDACTED:openai]");
    expect(cardList).toContain("use pnpm");
    expect(cardList).not.toContain(secret);
    expect(cardList).not.toContain("[REDACTED:openai]");
  });

  it("searches the redacted fact view without exposing raw secrets", () => {
    const secret = "sk-FAKEFAKEFAKEFAKEFAKE0123abcd";
    rt.facts.insert({
      subject: `repo-${secret}`,
      predicate: "deploy_token",
      object: secret,
      fact_kind: "decision",
      temporal_kind: "static",
      scope: { user_id: rt.userId, workspace_id: rt.workspaceId },
      trust_tier: "high",
      status: "active",
      promotion_state: "workspace_active",
      source: { asserted_by: "user", event_ids: [], raw_quote: `token is ${secret}` },
      tags: [],
    });
    rt.facts.insert({
      subject: "repo",
      predicate: "test_command",
      object: "pnpm vitest run",
      fact_kind: "procedural",
      temporal_kind: "static",
      scope: { user_id: rt.userId, workspace_id: rt.workspaceId },
      trust_tier: "high",
      status: "active",
      promotion_state: "workspace_active",
      source: { asserted_by: "deterministic_parser", event_ids: [] },
      tags: [],
    });

    const views = factViews(rt);
    const commandMatches = filterFactViews(views, "vitest");
    const redactedMatches = filterFactViews(views, "[REDACTED:openai]");
    const renderedText = JSON.stringify([...commandMatches, ...redactedMatches].map((v) => v.text));

    expect(commandMatches).toHaveLength(1);
    expect(commandMatches[0]?.text).toContain("vitest");
    expect(redactedMatches).toHaveLength(1);
    expect(renderedText).not.toContain(secret);
  });

  it("empty workspace yields zeroed stats", () => {
    const s = memoryStats(rt);
    expect(s.total).toBe(0);
    expect(s.active).toBe(0);
    expect(s.openLoops).toBe(0);
  });
});

describe("tui/app — control window scrolling", () => {
  it("keeps the selected row visible while moving down", () => {
    expect(clampWindowStart(0, 0, 20, 5)).toBe(0);
    expect(clampWindowStart(4, 0, 20, 5)).toBe(0);
    expect(clampWindowStart(5, 0, 20, 5)).toBe(1);
    expect(clampWindowStart(19, 14, 20, 5)).toBe(15);
  });

  it("moves the window back up and clamps short lists", () => {
    expect(clampWindowStart(7, 10, 20, 5)).toBe(7);
    expect(clampWindowStart(2, 10, 20, 5)).toBe(2);
    expect(clampWindowStart(3, 4, 4, 10)).toBe(0);
    expect(clampWindowStart(0, 0, 0, 5)).toBe(0);
  });
});

describe("tui/app — non-interactive snapshots", () => {
  it("renders the requested control tab in non-TTY mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphctx-tui-snapshot-"));
    const rt = new Runtime({ workspaceDir: dir });
    try {
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
      const app = new TuiApp(dir, "control");
      try {
        const snapshot = app.snapshot();
        expect(snapshot).toContain("Control panel");
        expect(snapshot).toContain("use pnpm");
      } finally {
        app.close();
      }
    } finally {
      rt.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders the requested monitor tab in non-TTY mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphctx-tui-snapshot-"));
    const app = new TuiApp(dir, "monitor");
    try {
      expect(app.snapshot()).toContain("Live push monitor");
    } finally {
      app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders composed empty states without overflowing", () => {
    withStdoutColumns(72, () => {
      const dir = mkdtempSync(join(tmpdir(), "graphctx-tui-empty-"));
      try {
        for (const tab of ["dashboard", "control", "monitor"] as const) {
          const app = new TuiApp(dir, tab);
          try {
            const snapshot = app.snapshot();
            if (tab === "dashboard") expect(snapshot).toContain("No memory yet");
            if (tab === "control") expect(snapshot).toContain("Nothing to manage");
            if (tab === "monitor") expect(snapshot).toContain("No push events");
            for (const line of snapshot.split("\n")) {
              expect(visibleLen(line)).toBeLessThanOrEqual(72);
            }
          } finally {
            app.close();
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("redacts secret text in the selected control detail panel", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphctx-tui-snapshot-"));
    const rt = new Runtime({ workspaceDir: dir });
    const secret = "sk-FAKEFAKEFAKEFAKEFAKE0123abcd";
    try {
      rt.facts.insert({
        subject: `repo-${secret}`,
        predicate: "deploy_token",
        object: secret,
        fact_kind: "decision",
        temporal_kind: "static",
        scope: { user_id: rt.userId, workspace_id: rt.workspaceId },
        trust_tier: "high",
        status: "active",
        promotion_state: "workspace_active",
        source: { asserted_by: "user", event_ids: [], raw_quote: `token is ${secret}` },
        tags: [],
      });
      const app = new TuiApp(dir, "control");
      try {
        const snapshot = app.snapshot();
        expect(snapshot).toContain("Selected");
        expect(snapshot).toContain("[REDACTED:openai]");
        expect(snapshot).not.toContain(secret);
      } finally {
        app.close();
      }
    } finally {
      rt.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tui/app — responsive terminal layout", () => {
  it("keeps dashboard and control snapshots inside the terminal width", () => {
    withStdoutColumns(58, () => {
      const dir = mkdtempSync(join(tmpdir(), "graphctx-tui-width-"));
      const rt = new Runtime({ workspaceDir: dir });
      try {
        rt.facts.insert({
          subject: "repo",
          predicate: "note",
          object:
            "this is a deliberately long operational memory that should truncate cleanly in narrow terminals",
          fact_kind: "decision",
          temporal_kind: "static",
          scope: { user_id: rt.userId, workspace_id: rt.workspaceId },
          trust_tier: "high",
          status: "active",
          promotion_state: "workspace_active",
          source: { asserted_by: "user", event_ids: [] },
          tags: [],
        });

        for (const tab of ["dashboard", "control"] as const) {
          const app = new TuiApp(dir, tab);
          try {
            for (const line of app.snapshot().split("\n")) {
              expect(visibleLen(line)).toBeLessThanOrEqual(58);
            }
          } finally {
            app.close();
          }
        }
      } finally {
        rt.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("wraps dense footer controls without overflowing", () => {
    const lines = wrapFooterParts(
      [
        "tab/1-3 switch",
        "up/down move",
        "f filter",
        "r refresh",
        "q quit",
        "n new",
        "o open-loop",
        "p promote",
        "x forget",
        "enter resolve",
      ],
      clampTuiWidth(48),
    );

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(visibleLen(line)).toBeLessThanOrEqual(48);
    }
  });

  it("keeps active prompts bounded and redacts typed secrets", () => {
    const secret = "sk-FAKEFAKEFAKEFAKEFAKE0123abcd";
    const lines = renderPromptFooter(
      "New fact (remember)",
      `store this ${secret} and then keep typing past the edge`,
      42,
    );

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).toContain("[REDACTED:openai]");
    for (const line of lines) {
      expect(visibleLen(line)).toBeLessThanOrEqual(42);
    }
  });
});

function withStdoutColumns<T>(columns: number, run: () => T): T {
  const current = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: columns,
  });
  try {
    return run();
  } finally {
    if (current) {
      Object.defineProperty(process.stdout, "columns", current);
    } else {
      Reflect.deleteProperty(process.stdout, "columns");
    }
  }
}

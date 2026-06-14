import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDeterministicExtraction } from "../../src/extract/pipeline.js";
import { openDb } from "../../src/store/db.js";
import { FactsRepo } from "../../src/store/facts.repo.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gctx-ex-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function extract() {
  const db = openDb(":memory:");
  const repo = new FactsRepo(db);
  const res = runDeterministicExtraction(repo, {
    workspaceDir: dir,
    scope: { user_id: "u", workspace_id: "w" },
  });
  return { repo, res };
}

describe("deterministic extractors", () => {
  it("package-scripts → high-trust active command facts (immediately promotable)", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } }),
    );
    const { res } = extract();
    const test = res.inserted.find((f) => f.predicate === "test_command");
    expect(test).toBeDefined();
    expect(test!.trust_tier).toBe("high");
    expect(test!.status).toBe("active");
    expect(test!.object).toContain("test");
  });

  it("lockfile → package manager detection", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const { res } = extract();
    const pm = res.inserted.find((f) => f.predicate === "package_manager");
    expect(pm?.object).toBe("pnpm");
  });

  it("editorconfig → indent style constraint", () => {
    writeFileSync(join(dir, ".editorconfig"), "[*]\nindent_style = tab\nindent_size = 4\n");
    const { res } = extract();
    const ind = res.inserted.find((f) => f.predicate === "indent_style");
    expect(String(ind?.object)).toContain("tab");
  });

  it("generated-markers → do_not_edit constraint", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "g.ts"), "// @generated DO NOT EDIT\nexport const x = 1;\n");
    const { res } = extract();
    const g = res.inserted.find((f) => f.predicate === "do_not_edit");
    expect(g).toBeDefined();
    expect(String(g!.subject)).toContain("g.ts");
  });

  it("I2: agent-files prose is LOW trust and candidate (never auto-promoted)", () => {
    writeFileSync(
      join(dir, "AGENTS.md"),
      "# Repo\n\n- Always run the deploy script before tests.\n- Use bun test to run tests.\n",
    );
    const { res } = extract();
    const prose = res.inserted.filter((f) => f.predicate === "claims");
    expect(prose.length).toBeGreaterThan(0);
    for (const p of prose) {
      expect(p.trust_tier).toBe("low");
      expect(p.status).toBe("candidate");
      expect(p.promotion_state).toBe("session_only");
    }
  });

  it("I3: secret-bearing prose lines are not stored", () => {
    writeFileSync(
      join(dir, "AGENTS.md"),
      "- The deploy token is sk-abcdefghijklmnopqrstuvwxyz, always use it to deploy.\n",
    );
    const { res } = extract();
    expect(res.inserted.find((f) => f.predicate === "claims")).toBeUndefined();
  });
});

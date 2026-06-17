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
      JSON.stringify({
        name: "graphctx",
        type: "module",
        engines: { node: ">=20" },
        bin: { graphctx: "dist/cli.js" },
        scripts: { test: "vitest run", build: "tsc" },
      }),
    );
    const { res } = extract();
    const test = res.inserted.find((f) => f.predicate === "test_command");
    expect(test).toBeDefined();
    expect(test!.trust_tier).toBe("high");
    expect(test!.status).toBe("active");
    expect(test!.object).toContain("test");
    expect(res.inserted).toContainEqual(
      expect.objectContaining({
        predicate: "node_engine",
        object: ">=20",
        fact_kind: "constraint",
      }),
    );
    expect(res.inserted).toContainEqual(
      expect.objectContaining({
        predicate: "cli_bin",
        object: "graphctx -> dist/cli.js",
      }),
    );
  });

  it("package-scripts use the declared package manager or lockfile runner", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run" },
        packageManager: "pnpm@10.12.0",
      }),
    );
    const declared = extract();
    expect(declared.res.inserted.find((f) => f.predicate === "test_command")?.object).toBe(
      "pnpm run test",
    );
    expect(declared.res.inserted.find((f) => f.predicate === "package_manager")?.object).toBe(
      "pnpm",
    );

    rmSync(join(dir, "package.json"), { force: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    writeFileSync(join(dir, "bun.lock"), "");
    const locked = extract();
    expect(locked.res.inserted.find((f) => f.predicate === "test_command")?.object).toBe(
      "bun run test",
    );
  });

  it("lockfile → package manager detection", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const { res } = extract();
    const pm = res.inserted.find((f) => f.predicate === "package_manager");
    expect(pm?.object).toBe("pnpm");
  });

  it("runtime pin files → high-trust version constraints", () => {
    writeFileSync(join(dir, ".nvmrc"), "20.11.1\n");
    writeFileSync(join(dir, ".tool-versions"), "nodejs 20.11.1\npnpm 10.12.0\n");

    const { res } = extract();
    expect(res.inserted).toContainEqual(
      expect.objectContaining({
        subject: "runtime node",
        predicate: "version_pin",
        object: "20.11.1",
        fact_kind: "constraint",
        trust_tier: "high",
        status: "active",
      }),
    );
    expect(res.inserted).toContainEqual(
      expect.objectContaining({
        subject: "runtime pnpm",
        predicate: "version_pin",
        object: "10.12.0",
      }),
    );
    expect(res.inserted.find((f) => f.subject === "runtime pnpm")?.git?.path_globs).toEqual([
      ".tool-versions",
    ]);
  });

  it("editorconfig → indent style constraint", () => {
    writeFileSync(join(dir, ".editorconfig"), "[*]\nindent_style = tab\nindent_size = 4\n");
    const { res } = extract();
    const ind = res.inserted.find((f) => f.predicate === "indent_style");
    expect(String(ind?.object)).toContain("tab");
  });

  it("tsconfig → high-trust TypeScript compiler constraints from JSONC", () => {
    writeFileSync(
      join(dir, "tsconfig.json"),
      `{
        // tsconfig files usually allow comments and trailing commas.
        "compilerOptions": {
          "target": "ES2022",
          "moduleResolution": "Bundler",
          "strict": true,
          "noUncheckedIndexedAccess": true,
        },
        "include": ["src/**/*.ts"],
      }`,
    );

    const { res } = extract();
    const strict = res.inserted.find((f) => f.predicate === "typescript_strict_mode");
    const include = res.inserted.find((f) => f.predicate === "typescript_include_globs");

    expect(strict).toMatchObject({
      object: true,
      trust_tier: "high",
      status: "active",
      promotion_state: "workspace_active",
    });
    expect(include?.object).toEqual(["src/**/*.ts"]);
    expect(strict?.git?.path_globs).toEqual(["tsconfig.json"]);
  });

  it("tooling config → high-trust lint and format constraints", () => {
    writeFileSync(
      join(dir, "biome.json"),
      `{
        "formatter": {
          "enabled": true,
          "indentStyle": "space",
          "lineWidth": 100,
        },
        "linter": {
          "enabled": true,
          "rules": {
            "suspicious": {
              "noExplicitAny": "warn",
            },
          },
        },
        "organizeImports": { "enabled": true },
      }`,
    );

    const { res } = extract();
    expect(res.inserted).toContainEqual(
      expect.objectContaining({
        predicate: "lint_tool",
        object: "biome",
        trust_tier: "high",
        status: "active",
      }),
    );
    expect(res.inserted).toContainEqual(
      expect.objectContaining({
        predicate: "formatter_line_width",
        object: 100,
      }),
    );
    expect(res.inserted).toContainEqual(
      expect.objectContaining({
        subject: "biome rule suspicious.noExplicitAny",
        predicate: "linter_rule_level",
        object: "warn",
      }),
    );
    expect(res.inserted.find((f) => f.predicate === "organize_imports")?.git?.path_globs).toEqual([
      "biome.json",
    ]);
  });

  it("docker config → high-trust container and compose facts", () => {
    writeFileSync(
      join(dir, "Dockerfile"),
      "FROM --platform=$BUILDPLATFORM node:22-alpine AS app\nWORKDIR /srv/app\nEXPOSE 3000 9229\nUSER node\n",
    );
    writeFileSync(
      join(dir, "docker-compose.yml"),
      [
        "services:",
        "  web:",
        "    build: .",
        "    ports:",
        '      - "3000:3000"',
        "  redis:",
        "    image: redis:7-alpine",
      ].join("\n"),
    );

    const { res } = extract();
    expect(res.inserted).toContainEqual(
      expect.objectContaining({
        subject: "Dockerfile",
        predicate: "container_base_image",
        object: "node:22-alpine",
      }),
    );
    expect(res.inserted).toContainEqual(
      expect.objectContaining({
        subject: "Dockerfile",
        predicate: "container_user",
        object: "node",
        fact_kind: "constraint",
      }),
    );
    expect(res.inserted).toContainEqual(
      expect.objectContaining({
        subject: "compose service web",
        predicate: "compose_build_context",
        object: ".",
      }),
    );
    expect(res.inserted.find((f) => f.predicate === "compose_port")?.git?.path_globs).toEqual([
      "docker-compose.yml",
    ]);
  });

  it("test config → high-trust runner and coverage facts", () => {
    writeFileSync(
      join(dir, "vitest.config.ts"),
      [
        'import { defineConfig } from "vitest/config";',
        "export default defineConfig({",
        "  test: {",
        '    include: ["test/**/*.test.ts"],',
        '    environment: "node",',
        "    testTimeout: 30000,",
        "    coverage: {",
        '      provider: "v8",',
        '      include: ["src/**/*.ts"],',
        '      exclude: ["src/cli.ts"],',
        "    },",
        "  },",
        "});",
      ].join("\n"),
    );

    const { res } = extract();
    expect(res.inserted).toContainEqual(
      expect.objectContaining({
        predicate: "test_runner",
        object: "vitest",
        trust_tier: "high",
      }),
    );
    expect(res.inserted).toContainEqual(
      expect.objectContaining({
        predicate: "test_environment",
        object: "node",
      }),
    );
    expect(res.inserted).toContainEqual(
      expect.objectContaining({
        predicate: "coverage_provider",
        object: "v8",
      }),
    );
    expect(
      res.inserted.find((f) => f.predicate === "coverage_exclude_globs")?.git?.path_globs,
    ).toEqual(["vitest.config.ts"]);
  });

  it("generated-markers → do_not_edit constraint", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "g.ts"), "// @generated DO NOT EDIT\nexport const x = 1;\n");
    const { res } = extract();
    const g = res.inserted.find((f) => f.predicate === "do_not_edit");
    expect(g).toBeDefined();
    expect(String(g!.subject)).toContain("g.ts");
  });

  it("I3: secret-bearing extracted subjects are skipped before storage", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    const secretPath = "src/ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE.ts";
    writeFileSync(join(dir, secretPath), "// @generated DO NOT EDIT\nexport const x = 1;\n");
    const { res } = extract();
    expect(res.skippedSecret).toBe(1);
    expect(res.inserted.find((f) => f.predicate === "do_not_edit")).toBeUndefined();
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

  it("expires high-trust deterministic facts when their evidence disappears", () => {
    const db = openDb(":memory:");
    const repo = new FactsRepo(db);
    const ctx = {
      workspaceDir: dir,
      scope: { user_id: "u", workspace_id: "w" },
      head: "commit-1",
    };

    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const first = runDeterministicExtraction(repo, ctx);
    const remembered = first.inserted.find((f) => f.predicate === "test_command");
    expect(remembered?.status).toBe("active");

    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    const second = runDeterministicExtraction(repo, { ...ctx, head: "commit-2" });
    const historical = repo.get(remembered!.fact_id);

    expect(second.expiredStale).toBe(1);
    expect(historical?.status).toBe("expired");
    expect(historical?.git?.valid_until_commit).toBe("commit-2");
    expect(repo.activeAsOf({ user_id: "u", workspace_id: "w" })).not.toContainEqual(
      expect.objectContaining({ fact_id: remembered!.fact_id }),
    );
  });
});

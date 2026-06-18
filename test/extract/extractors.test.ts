import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("package-scripts ignore package and lockfile evidence symlinked outside the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "gctx-ex-pkg-outside-"));
    try {
      writeFileSync(
        join(outside, "package.json"),
        JSON.stringify({ name: "external", scripts: { test: "vitest run" } }),
      );
      symlinkSync(join(outside, "package.json"), join(dir, "package.json"), "file");
      const externalPackage = extract();
      expect(
        externalPackage.res.inserted.find((f) => f.predicate === "test_command"),
      ).toBeUndefined();
      expect(
        externalPackage.res.inserted.find((f) => f.predicate === "package_name"),
      ).toBeUndefined();

      rmSync(join(dir, "package.json"), { force: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
      writeFileSync(join(outside, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      symlinkSync(join(outside, "pnpm-lock.yaml"), join(dir, "pnpm-lock.yaml"), "file");
      const externalLockfile = extract();
      expect(
        externalLockfile.res.inserted.find((f) => f.predicate === "test_command")?.object,
      ).toBe("npm run test");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("lockfile → package manager detection", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const { res } = extract();
    const pm = res.inserted.find((f) => f.predicate === "package_manager");
    expect(pm?.object).toBe("pnpm");
  });

  it("lockfile extraction ignores lockfiles symlinked outside the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "gctx-ex-lock-outside-"));
    try {
      writeFileSync(join(outside, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      symlinkSync(join(outside, "pnpm-lock.yaml"), join(dir, "pnpm-lock.yaml"), "file");
      const { res } = extract();
      expect(res.inserted.find((f) => f.predicate === "package_manager")).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

  it("runtime pin extraction ignores version files symlinked outside the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "gctx-ex-runtime-outside-"));
    try {
      writeFileSync(join(outside, ".nvmrc"), "22.13.0\n");
      writeFileSync(join(outside, ".tool-versions"), "nodejs 22.13.0\npnpm 10.12.0\n");
      symlinkSync(join(outside, ".nvmrc"), join(dir, ".nvmrc"), "file");
      symlinkSync(join(outside, ".tool-versions"), join(dir, ".tool-versions"), "file");

      const { res } = extract();
      expect(res.inserted.find((f) => f.predicate === "version_pin")).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("editorconfig → indent style constraint", () => {
    writeFileSync(join(dir, ".editorconfig"), "[*]\nindent_style = tab\nindent_size = 4\n");
    const { res } = extract();
    const ind = res.inserted.find((f) => f.predicate === "indent_style");
    expect(String(ind?.object)).toContain("tab");
  });

  it("editorconfig extraction ignores config symlinked outside the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "gctx-ex-editorconfig-outside-"));
    try {
      writeFileSync(join(outside, ".editorconfig"), "[*]\nindent_style = tab\n");
      symlinkSync(join(outside, ".editorconfig"), join(dir, ".editorconfig"), "file");

      const { res } = extract();
      expect(res.inserted.find((f) => f.predicate === "indent_style")).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

  it("tsconfig extraction ignores config symlinked outside the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "gctx-ex-tsconfig-outside-"));
    try {
      writeFileSync(
        join(outside, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      symlinkSync(join(outside, "tsconfig.json"), join(dir, "tsconfig.json"), "file");

      const { res } = extract();
      expect(res.inserted.find((f) => f.predicate === "typescript_strict_mode")).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

  it("tooling config extraction ignores config symlinked outside the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "gctx-ex-tooling-outside-"));
    try {
      writeFileSync(
        join(outside, "biome.json"),
        JSON.stringify({ formatter: { lineWidth: 120 }, linter: { enabled: true } }),
      );
      symlinkSync(join(outside, "biome.json"), join(dir, "biome.json"), "file");

      const { res } = extract();
      expect(res.inserted.find((f) => f.predicate === "lint_tool")).toBeUndefined();
      expect(res.inserted.find((f) => f.predicate === "formatter_line_width")).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

  it("docker extraction ignores Docker and Compose files symlinked outside the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "gctx-ex-docker-outside-"));
    try {
      writeFileSync(join(outside, "Dockerfile"), "FROM node:22-alpine\n");
      writeFileSync(join(outside, "docker-compose.yml"), "services:\n  web:\n    image: nginx\n");
      symlinkSync(join(outside, "Dockerfile"), join(dir, "Dockerfile"), "file");
      symlinkSync(join(outside, "docker-compose.yml"), join(dir, "docker-compose.yml"), "file");

      const { res } = extract();
      expect(res.inserted.find((f) => f.predicate === "container_base_image")).toBeUndefined();
      expect(res.inserted.find((f) => f.predicate === "compose_service")).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

  it("test config extraction ignores config symlinked outside the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "gctx-ex-test-config-outside-"));
    try {
      writeFileSync(
        join(outside, "vitest.config.ts"),
        'export default { test: { environment: "node", testTimeout: 30000 } };\n',
      );
      symlinkSync(join(outside, "vitest.config.ts"), join(dir, "vitest.config.ts"), "file");

      const { res } = extract();
      expect(res.inserted.find((f) => f.predicate === "test_runner")).toBeUndefined();
      expect(res.inserted.find((f) => f.predicate === "test_environment")).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("generated-markers → do_not_edit constraint", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "g.ts"), "// @generated DO NOT EDIT\nexport const x = 1;\n");
    const { res } = extract();
    const g = res.inserted.find((f) => f.predicate === "do_not_edit");
    expect(g).toBeDefined();
    expect(String(g!.subject)).toContain("g.ts");
  });

  it("generated-markers does not follow symlinked directories outside the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "gctx-ex-outside-"));
    try {
      writeFileSync(
        join(outside, "external.ts"),
        "// @generated DO NOT EDIT\nexport const x = 1;\n",
      );
      symlinkSync(outside, join(dir, "linked"), "dir");
      const { res } = extract();
      expect(res.inserted.find((f) => f.predicate === "do_not_edit")).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

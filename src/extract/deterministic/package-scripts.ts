import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NewFact } from "../../core/types.js";
import { type ExtractContext, type Extractor, structuredFact } from "./types.js";

interface PackageJson {
  name?: unknown;
  type?: unknown;
  scripts?: Record<string, string>;
  engines?: { node?: unknown };
  bin?: unknown;
  packageManager?: unknown;
  workspaces?: unknown;
}

type ScriptRunner = "npm" | "pnpm" | "yarn" | "bun";

// Maps common script names to a canonical predicate.
const SCRIPT_PREDICATE: Record<string, string> = {
  test: "test_command",
  build: "build_command",
  dev: "dev_command",
  start: "start_command",
  lint: "lint_command",
  typecheck: "typecheck_command",
  format: "format_command",
};

export const packageScriptsExtractor: Extractor = {
  id: "package.json",
  extract(ctx: ExtractContext): NewFact[] {
    const pkgPath = join(ctx.workspaceDir, "package.json");
    if (!existsSync(pkgPath)) return [];
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      return [];
    }
    const scripts = pkg.scripts ?? {};
    const runner = detectScriptRunner(ctx, pkg);
    const facts: NewFact[] = [];
    for (const [name, body] of Object.entries(scripts)) {
      const predicate = SCRIPT_PREDICATE[name];
      if (!predicate) continue;
      facts.push(
        structuredFact({
          subject: "repo",
          predicate,
          object: scriptCommand(runner, name),
          fact_kind: "semantic",
          temporal_kind: "static",
          scope: ctx.scope,
          tags: ["command", name, "config_file", `runner:${runner}`],
          rawQuote: `package.json scripts.${name}: ${body}`,
          git: anchor(ctx, ["package.json"]),
        }),
      );
    }
    facts.push(...packageMetadataFacts(ctx, pkg));
    return facts;
  },
};

function detectScriptRunner(ctx: ExtractContext, pkg: PackageJson): ScriptRunner {
  const declared = parseDeclaredPackageManager(pkg.packageManager);
  if (declared) return declared;
  if (existsSync(join(ctx.workspaceDir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(ctx.workspaceDir, "yarn.lock"))) return "yarn";
  if (
    existsSync(join(ctx.workspaceDir, "bun.lock")) ||
    existsSync(join(ctx.workspaceDir, "bun.lockb"))
  ) {
    return "bun";
  }
  return "npm";
}

function parseDeclaredPackageManager(value: unknown): ScriptRunner | null {
  if (typeof value !== "string") return null;
  const name = value.trim().split("@")[0];
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" ? name : null;
}

function scriptCommand(runner: ScriptRunner, name: string): string {
  return `${runner} run ${name}`;
}

function packageMetadataFacts(ctx: ExtractContext, pkg: PackageJson): NewFact[] {
  const facts: NewFact[] = [];
  if (typeof pkg.name === "string" && pkg.name.trim()) {
    facts.push(
      packageFact(ctx, {
        predicate: "package_name",
        object: pkg.name.trim(),
        tags: ["package", "config_file"],
        rawQuote: `package.json name: ${pkg.name.trim()}`,
      }),
    );
  }

  if (typeof pkg.type === "string" && pkg.type.trim()) {
    facts.push(
      packageFact(ctx, {
        predicate: "node_module_type",
        object: pkg.type.trim(),
        tags: ["node", "runtime", "config_file"],
        rawQuote: `package.json type: ${pkg.type.trim()}`,
      }),
    );
  }

  if (typeof pkg.engines?.node === "string" && pkg.engines.node.trim()) {
    facts.push(
      packageFact(ctx, {
        predicate: "node_engine",
        object: pkg.engines.node.trim(),
        factKind: "constraint",
        tags: ["node", "runtime", "config_file"],
        rawQuote: `package.json engines.node: ${pkg.engines.node.trim()}`,
      }),
    );
  }

  if (typeof pkg.packageManager === "string" && pkg.packageManager.trim()) {
    facts.push(
      packageFact(ctx, {
        predicate: "declared_package_manager",
        object: pkg.packageManager.trim(),
        tags: ["dependency", "package", "config_file"],
        rawQuote: `package.json packageManager: ${pkg.packageManager.trim()}`,
      }),
    );
  }

  for (const bin of binEntries(pkg.bin)) {
    facts.push(
      packageFact(ctx, {
        predicate: "cli_bin",
        object: `${bin.name} -> ${bin.path}`,
        factKind: "semantic",
        tags: ["cli", "package", "config_file"],
        rawQuote: `package.json bin.${bin.name}: ${bin.path}`,
      }),
    );
  }

  const workspaces = workspaceGlobs(pkg.workspaces);
  if (workspaces.length > 0) {
    facts.push(
      packageFact(ctx, {
        predicate: "workspace_globs",
        object: workspaces,
        tags: ["workspace", "monorepo", "config_file"],
        rawQuote: `package.json workspaces: ${workspaces.join(", ")}`,
      }),
    );
  }

  return facts;
}

function packageFact(
  ctx: ExtractContext,
  options: {
    predicate: string;
    object: unknown;
    factKind?: "semantic" | "constraint";
    tags: string[];
    rawQuote: string;
  },
): NewFact {
  return structuredFact({
    subject: "repo",
    predicate: options.predicate,
    object: options.object,
    fact_kind: options.factKind ?? "semantic",
    temporal_kind: "static",
    scope: ctx.scope,
    tags: options.tags,
    rawQuote: options.rawQuote,
    git: anchor(ctx, ["package.json"]),
  });
}

function binEntries(bin: unknown): Array<{ name: string; path: string }> {
  if (typeof bin === "string" && bin.trim()) return [{ name: "default", path: bin.trim() }];
  if (!bin || typeof bin !== "object" || Array.isArray(bin)) return [];
  return Object.entries(bin as Record<string, unknown>)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].trim().length > 0,
    )
    .map(([name, path]) => ({ name, path: path.trim() }))
    .slice(0, 20);
}

function workspaceGlobs(workspaces: unknown): string[] {
  if (Array.isArray(workspaces)) return stringArray(workspaces);
  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) return [];
  return stringArray((workspaces as Record<string, unknown>).packages);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .slice(0, 50);
}

function anchor(ctx: ExtractContext, globs: string[]) {
  return {
    repo_id: ctx.repoId,
    branch: ctx.branch,
    valid_from_commit: ctx.head,
    introduced_by_commit: ctx.head,
    path_globs: globs,
  };
}

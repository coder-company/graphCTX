import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NewFact } from "../../core/types.js";
import { type ExtractContext, type Extractor, structuredFact } from "./types.js";

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
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      return [];
    }
    const scripts = pkg.scripts ?? {};
    const facts: NewFact[] = [];
    for (const [name, body] of Object.entries(scripts)) {
      const predicate = SCRIPT_PREDICATE[name];
      if (!predicate) continue;
      facts.push(
        structuredFact({
          subject: "repo",
          predicate,
          object: `npm run ${name}`,
          fact_kind: "semantic",
          temporal_kind: "static",
          scope: ctx.scope,
          tags: ["command", name, "config_file"],
          rawQuote: `package.json scripts.${name}: ${body}`,
          git: anchor(ctx, ["package.json"]),
        }),
      );
    }
    return facts;
  },
};

function anchor(ctx: ExtractContext, globs: string[]) {
  return {
    repo_id: ctx.repoId,
    branch: ctx.branch,
    valid_from_commit: ctx.head,
    introduced_by_commit: ctx.head,
    path_globs: globs,
  };
}

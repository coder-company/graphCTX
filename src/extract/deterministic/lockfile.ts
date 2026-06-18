import type { NewFact } from "../../core/types.js";
import { existingWorkspacePath } from "../../security/workspace-path.js";
import { type ExtractContext, type Extractor, structuredFact } from "./types.js";

// Detects the package manager from the lockfile present (SPEC §10.1).
const LOCKFILES: Array<{ file: string; manager: string; runner: string }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm", runner: "pnpm" },
  { file: "yarn.lock", manager: "yarn", runner: "yarn" },
  { file: "bun.lockb", manager: "bun", runner: "bun" },
  { file: "bun.lock", manager: "bun", runner: "bun" },
  { file: "package-lock.json", manager: "npm", runner: "npm run" },
];

export const lockfileExtractor: Extractor = {
  id: "lockfile",
  extract(ctx: ExtractContext): NewFact[] {
    for (const { file, manager, runner } of LOCKFILES) {
      if (!existingWorkspacePath(ctx.workspaceDir, file)) continue;
      return [
        structuredFact({
          subject: "repo",
          predicate: "package_manager",
          object: manager,
          fact_kind: "semantic",
          temporal_kind: "static",
          scope: ctx.scope,
          tags: ["dependency", "command", "config_file"],
          rawQuote: `lockfile ${file} → package manager ${manager} (scripts run via "${runner}")`,
          git: {
            repo_id: ctx.repoId,
            branch: ctx.branch,
            valid_from_commit: ctx.head,
            path_globs: [file],
          },
        }),
      ];
    }
    return [];
  },
};

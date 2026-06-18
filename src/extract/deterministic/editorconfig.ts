import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NewFact } from "../../core/types.js";
import { existingWorkspacePath } from "../../security/workspace-path.js";
import { type ExtractContext, type Extractor, structuredFact } from "./types.js";

// Parses .editorconfig for the root [*] section indentation rules.
export const editorconfigExtractor: Extractor = {
  id: ".editorconfig",
  extract(ctx: ExtractContext): NewFact[] {
    const p = join(ctx.workspaceDir, ".editorconfig");
    if (!existingWorkspacePath(ctx.workspaceDir, ".editorconfig")) return [];
    const text = readFileSync(p, "utf8");
    const rootSection = parseSection(text, "*");
    const facts: NewFact[] = [];
    const style = rootSection.indent_style;
    const size = rootSection.indent_size;
    if (style) {
      const obj = size ? `${style} (size ${size})` : style;
      facts.push(
        structuredFact({
          subject: "repo",
          predicate: "indent_style",
          object: obj,
          fact_kind: "constraint",
          temporal_kind: "static",
          scope: ctx.scope,
          tags: ["style", "config_file"],
          rawQuote: `.editorconfig [*] indent_style=${style}${size ? ` indent_size=${size}` : ""}`,
          git: {
            repo_id: ctx.repoId,
            branch: ctx.branch,
            valid_from_commit: ctx.head,
            path_globs: [".editorconfig"],
          },
        }),
      );
    }
    return facts;
  },
};

function parseSection(text: string, section: string): Record<string, string> {
  const lines = text.split("\n");
  const out: Record<string, string> = {};
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inSection = line.slice(1, -1) === section;
      continue;
    }
    if (!inSection || !line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

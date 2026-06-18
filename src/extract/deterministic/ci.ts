import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { NewFact } from "../../core/types.js";
import { existingWorkspacePath } from "../../security/workspace-path.js";
import { type ExtractContext, type Extractor, structuredFact } from "./types.js";

// Extracts canonical CI run commands from .github/workflows/*.yml.
export const ciExtractor: Extractor = {
  id: "ci",
  extract(ctx: ExtractContext): NewFact[] {
    const wfDir = join(ctx.workspaceDir, ".github", "workflows");
    if (!existingWorkspacePath(ctx.workspaceDir, join(".github", "workflows"))) return [];
    let files: string[];
    try {
      files = readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    } catch {
      return [];
    }
    const commands = new Set<string>();
    for (const f of files) {
      const workflowPath = join(".github", "workflows", f);
      if (!existingWorkspacePath(ctx.workspaceDir, workflowPath)) continue;
      let text: string;
      try {
        text = readFileSync(join(ctx.workspaceDir, workflowPath), "utf8");
      } catch {
        continue;
      }
      for (const cmd of extractRunCommands(text)) commands.add(cmd);
    }
    const facts: NewFact[] = [];
    let i = 0;
    for (const cmd of commands) {
      if (i >= 10) break;
      facts.push(
        structuredFact({
          subject: "repo",
          predicate: "ci_command",
          object: cmd,
          fact_kind: "procedural",
          temporal_kind: "static",
          scope: ctx.scope,
          tags: ["ci", "command", "config_file"],
          rawQuote: `CI runs: ${cmd}`,
          git: {
            repo_id: ctx.repoId,
            branch: ctx.branch,
            valid_from_commit: ctx.head,
            path_globs: [".github/workflows/*"],
          },
        }),
      );
      i++;
    }
    return facts;
  },
};

// Pull `run:` step commands out of a workflow file (single-line + block scalars).
function extractRunCommands(text: string): string[] {
  const cmds: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*-?\s*run:\s*(.*)$/.exec(lines[i] as string);
    if (!m) continue;
    const inline = (m[1] ?? "").trim();
    if (
      inline &&
      inline !== "|" &&
      inline !== ">" &&
      !inline.startsWith("|") &&
      !inline.startsWith(">")
    ) {
      cmds.push(stripQuotes(inline));
      continue;
    }
    // block scalar: collect indented following lines
    const baseIndent = (lines[i] as string).search(/\S/);
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j] as string;
      if (ln.trim() === "") continue;
      const indent = ln.search(/\S/);
      if (indent <= baseIndent) break;
      const t = ln.trim();
      if (t && !t.startsWith("#")) cmds.push(t);
    }
  }
  return cmds.filter((c) => c.length > 0 && c.length < 200);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

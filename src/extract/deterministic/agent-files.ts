import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NewFact } from "../../core/types.js";
import { containsSecret } from "../../security/secrets.js";
import { type ExtractContext, type Extractor, proseFact } from "./types.js";

// Repo prose (AGENTS.md/CLAUDE.md/README) → LOW trust (I2). Each non-trivial
// bullet/sentence becomes a candidate "claim" fact. Never executable, never
// auto-promoted. Secret-bearing lines are dropped (I3).
const FILES = ["AGENTS.md", "CLAUDE.md", "README.md"];
const MAX_CLAIMS_PER_FILE = 8;

export const agentFilesExtractor: Extractor = {
  id: "agent-files",
  extract(ctx: ExtractContext): NewFact[] {
    const facts: NewFact[] = [];
    for (const file of FILES) {
      const p = join(ctx.workspaceDir, file);
      if (!existsSync(p)) continue;
      let text: string;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      const claims = extractClaims(text).slice(0, MAX_CLAIMS_PER_FILE);
      for (const claim of claims) {
        if (containsSecret(claim)) continue; // I3
        facts.push(
          proseFact({
            subject: "repo",
            predicate: "claims",
            object: claim,
            fact_kind: "constraint",
            temporal_kind: "static",
            scope: ctx.scope,
            tags: ["prose", `source:${file}`],
            rawQuote: `${file}: ${claim}`,
            git: {
              repo_id: ctx.repoId,
              branch: ctx.branch,
              valid_from_commit: ctx.head,
              path_globs: [file],
            },
          }),
        );
      }
    }
    return facts;
  },
};

// Pull instruction-like lines (bullets / imperative sentences) from prose.
function extractClaims(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue; // headings
    if (line.startsWith("```")) continue;
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const candidate = bullet ? (bullet[1] ?? "") : line;
    if (candidate.length < 12 || candidate.length > 240) continue;
    // keep lines that look like guidance/conventions
    if (
      /\b(use|run|do not|don't|never|always|prefer|must|should|convention|note)\b/i.test(candidate)
    ) {
      out.push(candidate.replace(/`/g, ""));
    }
  }
  return [...new Set(out)];
}

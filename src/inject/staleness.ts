import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Fact } from "../core/types.js";

// Synchronous perishable-fact verification before injection (I4, SPEC §11).
// For procedural/path-bearing facts, confirm the referenced path still exists.
// Cost target < 5ms. Returns true = safe to inject.
export function isPerishable(fact: Fact): boolean {
  if (fact.fact_kind === "procedural") return true;
  if (fact.predicate === "do_not_edit") return true;
  if (fact.git?.path_globs && fact.git.path_globs.length > 0) {
    // only verify concrete (non-wildcard) paths
    return fact.git.path_globs.some((g) => !g.includes("*"));
  }
  return false;
}

export function verifyBeforeInject(fact: Fact, workspaceDir: string): boolean {
  if (!isPerishable(fact)) return true;
  const paths = (fact.git?.path_globs ?? []).filter((g) => !g.includes("*"));
  // generated-marker facts anchor on the file itself (subject = path)
  if (fact.predicate === "do_not_edit" && typeof fact.subject === "string") {
    paths.push(fact.subject);
  }
  if (paths.length === 0) return true; // nothing concrete to verify
  return paths.every((p) => existsSync(join(workspaceDir, p)));
}

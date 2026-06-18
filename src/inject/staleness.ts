import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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
  let rootRealPath: string;
  try {
    rootRealPath = realpathSync(workspaceDir);
  } catch {
    return false;
  }
  return paths.every((p) => {
    const fullPath = resolveWorkspacePath(workspaceDir, p);
    return !!fullPath && existingWorkspacePath(rootRealPath, fullPath);
  });
}

function existingWorkspacePath(rootRealPath: string, fullPath: string): boolean {
  try {
    const targetRealPath = realpathSync(fullPath);
    const rel = relative(rootRealPath, targetRealPath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
}

function resolveWorkspacePath(workspaceDir: string, path: string): string | undefined {
  if (!path || path.includes("\0")) return undefined;
  const root = resolve(workspaceDir);
  const fullPath = resolve(root, path);
  const rel = relative(root, fullPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return fullPath;
  return undefined;
}

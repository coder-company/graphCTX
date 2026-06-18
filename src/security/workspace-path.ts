import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function realWorkspaceRoot(workspaceDir: string): string | undefined {
  try {
    return realpathSync(workspaceDir);
  } catch {
    return undefined;
  }
}

export function existingWorkspacePath(
  workspaceDir: string,
  path: string,
  rootRealPath = realWorkspaceRoot(workspaceDir),
): boolean {
  if (!rootRealPath) return false;
  const fullPath = resolveWorkspacePath(workspaceDir, path);
  if (!fullPath) return false;
  try {
    const targetRealPath = realpathSync(fullPath);
    return pathInsideRoot(rootRealPath, targetRealPath);
  } catch {
    return false;
  }
}

export function resolveWorkspacePath(workspaceDir: string, path: string): string | undefined {
  if (!path || path.includes("\0")) return undefined;
  const root = resolve(workspaceDir);
  const fullPath = resolve(root, path);
  return pathInsideRoot(root, fullPath) ? fullPath : undefined;
}

function pathInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

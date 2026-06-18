import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { StoreError } from "../core/errors.js";

export function assertWorkspaceLocalStorePath(
  path: string,
  workspaceDir: string,
  label: string,
): void {
  const root = resolve(workspaceDir);
  const target = resolve(path);
  if (!isInside(root, target)) return;

  const parts = relative(root, target)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (isSymlink(current)) {
      throw new StoreError(
        `refusing to use symlinked ${label} path component: ${current}`,
        "replace the symlink with a regular path or configure storage outside the workspace explicitly",
      );
    }
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

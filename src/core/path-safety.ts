import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export function symlinkedPathComponent(path: string, root: string): string | null {
  const rootPath = resolve(root);
  const targetPath = resolve(path);
  if (!isInside(rootPath, targetPath)) return null;

  const parts = relative(rootPath, targetPath)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = rootPath;
  for (const part of parts) {
    current = join(current, part);
    if (isSymlink(current)) return current;
  }
  return null;
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

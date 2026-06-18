import { lstatSync } from "node:fs";
import { AdapterError } from "../core/errors.js";

export function assertWritableConfigPath(path: string, label: string): void {
  if (!isSymlink(path)) return;
  throw new AdapterError(
    `refusing to modify symlinked ${label}: ${path}`,
    `replace the symlink with a regular ${label}`,
  );
}

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

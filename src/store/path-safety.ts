import { StoreError } from "../core/errors.js";
import { symlinkedPathComponent } from "../core/path-safety.js";

export function assertWorkspaceLocalStorePath(
  path: string,
  workspaceDir: string,
  label: string,
): void {
  const symlink = symlinkedPathComponent(path, workspaceDir);
  if (!symlink) return;
  throw new StoreError(
    `refusing to use symlinked ${label} path component: ${symlink}`,
    "replace the symlink with a regular path or configure storage outside the workspace explicitly",
  );
}

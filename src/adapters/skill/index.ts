import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "../../core/errors.js";
import { assertWritableConfigPath } from "../config-path.js";
import { renderSkillMarkdown } from "./template.js";

// Each supported skill host gets ONE markdown file at a host-specific path.
// All paths are workspace-local except `codex` which is user-global, since
// Codex CLI reads its skills from `$HOME/.codex/skills/`.
export const SKILL_CLIENTS = ["claude", "cursor", "opencode", "codex", "generic"] as const;
export type SkillClient = (typeof SKILL_CLIENTS)[number];

export interface SkillTarget {
  client: SkillClient;
  // Absolute filesystem path the skill file is written to.
  path: string;
  // `true` if the destination already existed (force overwrite reported).
  existed: boolean;
}

export interface InstallSkillOptions {
  workspaceDir: string;
  client: SkillClient;
  binPath?: string;
  force?: boolean;
  // Test seam: alternate home dir for user-global skill destinations.
  homeDir?: string;
}

export function isSkillClient(value: string): value is SkillClient {
  return (SKILL_CLIENTS as readonly string[]).includes(value);
}

export function skillPath(
  client: SkillClient,
  workspaceDir: string,
  homeDir = process.env.HOME ?? "",
): string {
  switch (client) {
    case "claude":
      return join(workspaceDir, ".claude", "skills", "graphctx", "SKILL.md");
    case "cursor":
      return join(workspaceDir, ".cursor", "skills", "graphctx", "SKILL.md");
    case "opencode":
      return join(workspaceDir, ".opencode", "skills", "graphctx", "SKILL.md");
    case "codex":
      return join(homeDir, ".codex", "skills", "graphctx", "SKILL.md");
    case "generic":
      return join(workspaceDir, ".agents", "skills", "graphctx", "SKILL.md");
  }
}

// Write the canonical skill file. Fails closed if the destination already
// exists and `force` is not set, so we never clobber a user-edited skill.
export function installSkill(opts: InstallSkillOptions): SkillTarget {
  if (!isSkillClient(opts.client)) {
    throw new ValidationError(
      `unknown skill client "${opts.client}"`,
      `supported: ${SKILL_CLIENTS.join(", ")}`,
    );
  }
  const path = skillPath(opts.client, opts.workspaceDir, opts.homeDir);
  const dir = pathDir(path);
  assertWritableConfigPath(dir, `graphCTX skill directory for ${opts.client}`);
  assertWritableConfigPath(path, `graphCTX skill file for ${opts.client}`);
  const existed = existsSync(path);
  const desired = renderSkillMarkdown({ binPath: opts.binPath });
  if (existed && !opts.force) {
    const current = safeRead(path);
    if (current === desired) return { client: opts.client, path, existed };
    throw new ValidationError(`skill already installed at ${path}`, "pass --force to overwrite");
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, desired, "utf8");
  return { client: opts.client, path, existed };
}

function pathDir(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx === -1 ? "." : p.slice(0, idx);
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

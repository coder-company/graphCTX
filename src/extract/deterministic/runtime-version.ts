import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NewFact } from "../../core/types.js";
import { existingWorkspacePath } from "../../security/workspace-path.js";
import { type ExtractContext, type Extractor, structuredFact } from "./types.js";

const NODE_VERSION_FILES = [".nvmrc", ".node-version"];
const TOOL_VERSIONS = ".tool-versions";
const MAX_TOOL_VERSION_LINES = 40;

export const runtimeVersionExtractor: Extractor = {
  id: "runtime-version",
  extract(ctx: ExtractContext): NewFact[] {
    const facts: NewFact[] = [];

    for (const file of NODE_VERSION_FILES) {
      const version = firstMeaningfulLine(ctx, file);
      if (!version) continue;
      facts.push(runtimeVersionFact(ctx, file, "node", version));
    }

    const toolVersions = readToolVersions(ctx);
    for (const entry of toolVersions) {
      facts.push(
        runtimeVersionFact(ctx, TOOL_VERSIONS, normalizeToolName(entry.tool), entry.version),
      );
    }

    return facts;
  },
};

function firstMeaningfulLine(ctx: ExtractContext, file: string): string | null {
  const p = join(ctx.workspaceDir, file);
  if (!existingWorkspacePath(ctx.workspaceDir, file)) return null;
  try {
    const line = readFileSync(p, "utf8")
      .split("\n")
      .map((l) => stripComment(l).trim())
      .find((l) => l.length > 0);
    return line && line.length <= 80 ? line : null;
  } catch {
    return null;
  }
}

function readToolVersions(ctx: ExtractContext): Array<{ tool: string; version: string }> {
  const p = join(ctx.workspaceDir, TOOL_VERSIONS);
  if (!existingWorkspacePath(ctx.workspaceDir, TOOL_VERSIONS)) return [];
  let lines: string[];
  try {
    lines = readFileSync(p, "utf8").split("\n");
  } catch {
    return [];
  }

  const entries: Array<{ tool: string; version: string }> = [];
  for (const raw of lines.slice(0, MAX_TOOL_VERSION_LINES)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const [tool, ...versions] = line.split(/\s+/).filter(Boolean);
    const version = versions.join(" ");
    if (!tool || !version || tool.length > 40 || version.length > 120) continue;
    if (!/^[a-z0-9_.-]+$/i.test(tool)) continue;
    entries.push({ tool, version });
  }
  return entries.slice(0, 20);
}

function runtimeVersionFact(
  ctx: ExtractContext,
  file: string,
  tool: string,
  version: string,
): NewFact {
  return structuredFact({
    subject: `runtime ${tool}`,
    predicate: "version_pin",
    object: version,
    fact_kind: "constraint",
    temporal_kind: "static",
    scope: ctx.scope,
    tags: ["runtime", "version", "config_file", tool],
    rawQuote: `${file}: ${tool} ${version}`,
    git: {
      repo_id: ctx.repoId,
      branch: ctx.branch,
      valid_from_commit: ctx.head,
      introduced_by_commit: ctx.head,
      path_globs: [file],
    },
  });
}

function normalizeToolName(tool: string): string {
  return tool === "nodejs" ? "node" : tool;
}

function stripComment(line: string): string {
  const idx = line.indexOf("#");
  return idx === -1 ? line : line.slice(0, idx);
}

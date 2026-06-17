import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactKind, NewFact } from "../../core/types.js";
import { type ExtractContext, type Extractor, structuredFact } from "./types.js";

const CONFIG_FILE = "tsconfig.json";

interface TsConfig {
  extends?: unknown;
  compilerOptions?: Record<string, unknown>;
  include?: unknown;
  exclude?: unknown;
  references?: unknown;
}

const COMPILER_OPTIONS: Array<{
  option: string;
  predicate: string;
  factKind: FactKind;
  tag: string;
}> = [
  {
    option: "strict",
    predicate: "typescript_strict_mode",
    factKind: "constraint",
    tag: "type_safety",
  },
  {
    option: "noUncheckedIndexedAccess",
    predicate: "typescript_no_unchecked_indexed_access",
    factKind: "constraint",
    tag: "type_safety",
  },
  {
    option: "noImplicitOverride",
    predicate: "typescript_no_implicit_override",
    factKind: "constraint",
    tag: "type_safety",
  },
  {
    option: "noFallthroughCasesInSwitch",
    predicate: "typescript_no_fallthrough_cases",
    factKind: "constraint",
    tag: "type_safety",
  },
  {
    option: "target",
    predicate: "typescript_target",
    factKind: "semantic",
    tag: "runtime",
  },
  {
    option: "module",
    predicate: "typescript_module",
    factKind: "semantic",
    tag: "runtime",
  },
  {
    option: "moduleResolution",
    predicate: "typescript_module_resolution",
    factKind: "semantic",
    tag: "runtime",
  },
  {
    option: "rootDir",
    predicate: "typescript_source_root",
    factKind: "semantic",
    tag: "paths",
  },
  {
    option: "outDir",
    predicate: "typescript_output_dir",
    factKind: "semantic",
    tag: "paths",
  },
  {
    option: "declaration",
    predicate: "typescript_declaration_output",
    factKind: "semantic",
    tag: "types",
  },
];

export const tsconfigExtractor: Extractor = {
  id: CONFIG_FILE,
  extract(ctx: ExtractContext): NewFact[] {
    const path = join(ctx.workspaceDir, CONFIG_FILE);
    if (!existsSync(path)) return [];

    let parsed: TsConfig;
    try {
      parsed = parseTsConfig(readFileSync(path, "utf8"));
    } catch {
      return [];
    }

    const facts: NewFact[] = [];
    const compiler = parsed.compilerOptions ?? {};
    for (const option of COMPILER_OPTIONS) {
      const value = compiler[option.option];
      if (!isScalar(value)) continue;
      facts.push(
        structuredFact({
          subject: "repo",
          predicate: option.predicate,
          object: value,
          fact_kind: option.factKind,
          temporal_kind: "static",
          scope: ctx.scope,
          tags: ["typescript", "config_file", option.tag],
          rawQuote: `${CONFIG_FILE} compilerOptions.${option.option}: ${String(value)}`,
          git: anchor(ctx),
        }),
      );
    }

    const include = stringArray(parsed.include);
    if (include.length > 0) {
      facts.push(
        structuredFact({
          subject: "repo",
          predicate: "typescript_include_globs",
          object: include,
          fact_kind: "semantic",
          temporal_kind: "static",
          scope: ctx.scope,
          tags: ["typescript", "config_file", "paths"],
          rawQuote: `${CONFIG_FILE} include: ${include.join(", ")}`,
          git: anchor(ctx),
        }),
      );
    }

    const exclude = stringArray(parsed.exclude);
    if (exclude.length > 0) {
      facts.push(
        structuredFact({
          subject: "repo",
          predicate: "typescript_exclude_globs",
          object: exclude,
          fact_kind: "semantic",
          temporal_kind: "static",
          scope: ctx.scope,
          tags: ["typescript", "config_file", "paths"],
          rawQuote: `${CONFIG_FILE} exclude: ${exclude.join(", ")}`,
          git: anchor(ctx),
        }),
      );
    }

    if (typeof parsed.extends === "string" && parsed.extends.trim()) {
      facts.push(
        structuredFact({
          subject: "repo",
          predicate: "typescript_extends_config",
          object: parsed.extends.trim(),
          fact_kind: "semantic",
          temporal_kind: "static",
          scope: ctx.scope,
          tags: ["typescript", "config_file"],
          rawQuote: `${CONFIG_FILE} extends: ${parsed.extends.trim()}`,
          git: anchor(ctx),
        }),
      );
    }

    return facts;
  },
};

function parseTsConfig(text: string): TsConfig {
  const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as TsConfig;
}

function isScalar(value: unknown): value is string | number | boolean {
  return ["string", "number", "boolean"].includes(typeof value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .slice(0, 50);
}

function anchor(ctx: ExtractContext) {
  return {
    repo_id: ctx.repoId,
    branch: ctx.branch,
    valid_from_commit: ctx.head,
    introduced_by_commit: ctx.head,
    path_globs: [CONFIG_FILE],
  };
}

function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";
        i++;
      }
      i++;
      continue;
    }

    out += ch;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }

    out += ch;
  }
  return out;
}

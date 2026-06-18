import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactKind, NewFact } from "../../core/types.js";
import { existingWorkspacePath } from "../../security/workspace-path.js";
import { parseJsoncObject } from "./jsonc.js";
import { type ExtractContext, type Extractor, structuredFact } from "./types.js";

const BIOME_CONFIGS = ["biome.json", "biome.jsonc"];
const ESLINT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yml",
  ".eslintrc.yaml",
];
const PRETTIER_CONFIGS = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
];

export const toolingConfigExtractor: Extractor = {
  id: "tooling-config",
  extract(ctx: ExtractContext): NewFact[] {
    const facts: NewFact[] = [];

    const biome = firstExisting(ctx, BIOME_CONFIGS);
    if (biome) facts.push(...extractBiome(ctx, biome));

    const eslint = firstExisting(ctx, ESLINT_CONFIGS);
    if (eslint) {
      facts.push(
        toolFact(ctx, eslint, {
          predicate: "lint_tool",
          object: "eslint",
          factKind: "semantic",
          tags: ["lint", "config_file", "eslint"],
          rawQuote: `${eslint} configures ESLint linting`,
        }),
      );
    }

    const prettier = firstExisting(ctx, PRETTIER_CONFIGS);
    if (prettier) {
      facts.push(
        toolFact(ctx, prettier, {
          predicate: "format_tool",
          object: "prettier",
          factKind: "semantic",
          tags: ["format", "config_file", "prettier"],
          rawQuote: `${prettier} configures Prettier formatting`,
        }),
      );
    }

    return facts;
  },
};

function extractBiome(ctx: ExtractContext, file: string): NewFact[] {
  const facts: NewFact[] = [];
  let config: Record<string, unknown> = {};
  try {
    config = parseJsoncObject(readFileSync(join(ctx.workspaceDir, file), "utf8"));
  } catch {
    return [
      toolFact(ctx, file, {
        predicate: "code_quality_tool",
        object: "biome",
        factKind: "semantic",
        tags: ["lint", "format", "config_file", "biome"],
        rawQuote: `${file} configures Biome`,
      }),
    ];
  }

  const formatter = objectAt(config, "formatter");
  const linter = objectAt(config, "linter");
  const organizeImports = objectAt(config, "organizeImports");
  if (boolAt(formatter, "enabled") !== false) {
    facts.push(
      toolFact(ctx, file, {
        predicate: "format_tool",
        object: "biome",
        factKind: "semantic",
        tags: ["format", "config_file", "biome"],
        rawQuote: `${file} formatter.enabled: ${String(boolAt(formatter, "enabled") ?? true)}`,
      }),
    );
  }

  if (boolAt(linter, "enabled") !== false) {
    facts.push(
      toolFact(ctx, file, {
        predicate: "lint_tool",
        object: "biome",
        factKind: "semantic",
        tags: ["lint", "config_file", "biome"],
        rawQuote: `${file} linter.enabled: ${String(boolAt(linter, "enabled") ?? true)}`,
      }),
    );
  }

  addBiomeScalar(
    facts,
    ctx,
    file,
    formatter,
    "indentStyle",
    "formatter_indent_style",
    "constraint",
  );
  addBiomeScalar(
    facts,
    ctx,
    file,
    formatter,
    "indentWidth",
    "formatter_indent_width",
    "constraint",
  );
  addBiomeScalar(facts, ctx, file, formatter, "lineWidth", "formatter_line_width", "constraint");
  addBiomeScalar(
    facts,
    ctx,
    file,
    objectAt(config, "javascript", "formatter"),
    "quoteStyle",
    "formatter_quote_style",
    "constraint",
  );
  addBiomeScalar(
    facts,
    ctx,
    file,
    objectAt(config, "javascript", "formatter"),
    "trailingCommas",
    "formatter_trailing_commas",
    "constraint",
  );
  addBiomeScalar(
    facts,
    ctx,
    file,
    objectAt(config, "javascript", "formatter"),
    "semicolons",
    "formatter_semicolons",
    "constraint",
  );

  const importsEnabled = boolAt(organizeImports, "enabled");
  if (importsEnabled !== undefined) {
    facts.push(
      toolFact(ctx, file, {
        predicate: "organize_imports",
        object: importsEnabled,
        factKind: "constraint",
        tags: ["format", "imports", "config_file", "biome"],
        rawQuote: `${file} organizeImports.enabled: ${String(importsEnabled)}`,
      }),
    );
  }

  for (const rule of collectBiomeRules(objectAt(linter, "rules")).slice(0, 20)) {
    facts.push(
      toolFact(ctx, file, {
        subject: `biome rule ${rule.name}`,
        predicate: "linter_rule_level",
        object: rule.level,
        factKind: "constraint",
        tags: ["lint", "rule", "config_file", "biome"],
        rawQuote: `${file} linter.rules.${rule.name}: ${rule.level}`,
      }),
    );
  }

  return facts;
}

function addBiomeScalar(
  facts: NewFact[],
  ctx: ExtractContext,
  file: string,
  source: Record<string, unknown>,
  key: string,
  predicate: string,
  factKind: FactKind,
): void {
  const value = source[key];
  if (!isScalar(value)) return;
  facts.push(
    toolFact(ctx, file, {
      predicate,
      object: value,
      factKind,
      tags: ["format", "config_file", "biome"],
      rawQuote: `${file} ${key}: ${String(value)}`,
    }),
  );
}

function collectBiomeRules(
  rules: Record<string, unknown>,
  prefix = "",
): Array<{ name: string; level: string }> {
  const out: Array<{ name: string; level: string }> = [];
  for (const [key, value] of Object.entries(rules).sort(([a], [b]) => a.localeCompare(b))) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string" || typeof value === "boolean") {
      out.push({ name, level: String(value) });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(...collectBiomeRules(value as Record<string, unknown>, name));
    }
  }
  return out;
}

function toolFact(
  ctx: ExtractContext,
  file: string,
  options: {
    subject?: string;
    predicate: string;
    object: unknown;
    factKind: FactKind;
    tags: string[];
    rawQuote: string;
  },
): NewFact {
  return structuredFact({
    subject: options.subject ?? "repo",
    predicate: options.predicate,
    object: options.object,
    fact_kind: options.factKind,
    temporal_kind: "static",
    scope: ctx.scope,
    tags: options.tags,
    rawQuote: options.rawQuote,
    git: {
      repo_id: ctx.repoId,
      branch: ctx.branch,
      valid_from_commit: ctx.head,
      introduced_by_commit: ctx.head,
      path_globs: [file],
    },
  });
}

function firstExisting(ctx: ExtractContext, files: string[]): string | undefined {
  return files.find((file) => existingWorkspacePath(ctx.workspaceDir, file));
}

function objectAt(source: Record<string, unknown>, ...path: string[]): Record<string, unknown> {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return {};
    current = (current as Record<string, unknown>)[key];
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) return {};
  return current as Record<string, unknown>;
}

function boolAt(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === "boolean" ? value : undefined;
}

function isScalar(value: unknown): value is string | number | boolean {
  return ["string", "number", "boolean"].includes(typeof value);
}

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { NewFact } from "../../core/types.js";
import { containsSecret } from "../../security/secrets.js";
import { type ExtractContext, type Extractor, structuredFact } from "./types.js";

// Deterministic, dep-free repo-map ranker (Aider-inspired). Walks workspace
// source files, extracts top-level declarations as graph nodes and identifier
// references as edges, then runs damped PageRank over the result. The top-N
// symbols by rank become high-trust `repo importance <symbol>` facts that the
// planner can surface as cheap structural context.
//
// Design constraints (I9 fail-soft, < 50ms target):
// - regex-only parsing; no tree-sitter dep
// - hard caps on file count, file size, total symbols
// - SKIP_DIRS prevents walking node_modules / build output
// - secret-bearing names are dropped before insert (I3)
// - extractor is OPT-IN via env flag `GRAPHCTX_EXTRACT_PAGERANK=1`; not part
//   of the default DETERMINISTIC_EXTRACTORS list, so existing latency and
//   fact-count budgets are preserved unless the user opts in.

const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go"];
const SKIP_DIRS = new Set([
  ".git",
  ".graphctx",
  "node_modules",
  "dist",
  "dist-bin",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
]);
const MAX_FILES = 800;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SYMBOLS_PER_FILE = 64;
const MAX_REFS_PER_FILE = 256;
const TOP_N_FACTS = 12;
const PAGERANK_DAMPING = 0.85;
const PAGERANK_ITERS = 25;

interface Symbol {
  name: string;
  file: string;
}

interface Graph {
  // symbol name → set of symbol names referenced
  edges: Map<string, Set<string>>;
  // symbol name → home file (first declaration wins)
  defs: Map<string, string>;
}

export const repoPagerankExtractor: Extractor = {
  id: "repo-pagerank",
  extract(ctx: ExtractContext): NewFact[] {
    if (process.env.GRAPHCTX_EXTRACT_PAGERANK !== "1") return [];
    let files: string[];
    try {
      files = walkSourceFiles(ctx.workspaceDir);
    } catch {
      return [];
    }
    if (files.length === 0) return [];
    const graph = buildGraph(files, ctx.workspaceDir);
    if (graph.defs.size === 0) return [];
    const ranks = pagerank(graph);
    return topFacts(ranks, graph, ctx);
  },
};

function walkSourceFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      if (name.startsWith(".") && name !== ".") continue;
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) continue;
      const dot = name.lastIndexOf(".");
      if (dot === -1) continue;
      const ext = name.slice(dot).toLowerCase();
      if (!SOURCE_EXTS.includes(ext)) continue;
      out.push(full);
      if (out.length >= MAX_FILES) break;
    }
  }
  return out;
}

// Top-level declaration patterns. Intentionally permissive but anchored at
// line start to avoid matching inner-scope `function ()` etc.
const DECL_PATTERNS: RegExp[] = [
  // JS/TS
  /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm,
  /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  /^class\s+([A-Za-z_$][\w$]*)/gm,
  // Python
  /^def\s+([A-Za-z_][\w]*)/gm,
  /^class\s+([A-Za-z_][\w]*)/gm,
  // Rust
  /^pub\s+(?:async\s+)?fn\s+([A-Za-z_][\w]*)/gm,
  /^pub\s+struct\s+([A-Za-z_][\w]*)/gm,
  /^pub\s+enum\s+([A-Za-z_][\w]*)/gm,
  /^pub\s+trait\s+([A-Za-z_][\w]*)/gm,
  // Go
  /^func\s+(?:\([^)]*\)\s+)?([A-Z][\w]*)/gm,
  /^type\s+([A-Z][\w]*)/gm,
];

function buildGraph(files: string[], root: string): Graph {
  const defs = new Map<string, string>();
  const edges = new Map<string, Set<string>>();
  const fileSymbols: Array<{ file: string; symbols: Symbol[]; text: string }> = [];

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const symbols: Symbol[] = [];
    const seen = new Set<string>();
    for (const pat of DECL_PATTERNS) {
      pat.lastIndex = 0;
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: regex exec idiom
      while ((m = pat.exec(text)) && symbols.length < MAX_SYMBOLS_PER_FILE) {
        const name = m[1];
        if (!name || seen.has(name)) continue;
        if (!isCandidateSymbol(name)) continue;
        seen.add(name);
        symbols.push({ name, file });
        if (!defs.has(name)) defs.set(name, relative(root, file).split(sep).join("/"));
      }
    }
    fileSymbols.push({ file, symbols, text });
  }

  // Reference pass: for each declaring file, scan for any OTHER known symbol
  // names that appear in the body. Each (defining-symbol → referenced-symbol)
  // edge weight is implicit (counted once per file).
  for (const { symbols, text } of fileSymbols) {
    if (symbols.length === 0) continue;
    // collect ALL identifier tokens in this file (capped)
    const tokens = new Set<string>();
    const tokenRe = /\b([A-Za-z_$][\w$]{2,})\b/g;
    let t: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: regex exec idiom
    while ((t = tokenRe.exec(text)) && tokens.size < MAX_REFS_PER_FILE) {
      const name = t[1];
      if (!name) continue;
      if (defs.has(name)) tokens.add(name);
    }
    for (const src of symbols) {
      const outs = edges.get(src.name) ?? new Set<string>();
      for (const dst of tokens) {
        if (dst === src.name) continue;
        outs.add(dst);
      }
      edges.set(src.name, outs);
    }
  }
  return { defs, edges };
}

function isCandidateSymbol(name: string): boolean {
  if (name.length < 3 || name.length > 80) return false;
  if (/^[a-z]$/i.test(name)) return false;
  // skip very common control words that may accidentally match
  if (
    /^(if|for|while|do|else|case|switch|return|break|continue|throw|let|const|var|new|in|of|as|is|type|enum|class|fn|def|pub|impl|trait|struct|use|mod|fn|main|init|self|this|true|false|null|None|True|False)$/.test(
      name,
    )
  ) {
    return false;
  }
  return true;
}

function pagerank(graph: Graph): Map<string, number> {
  const N = graph.defs.size;
  if (N === 0) return new Map();
  const init = 1 / N;
  let rank = new Map<string, number>();
  for (const name of graph.defs.keys()) rank.set(name, init);

  // build reverse adjacency for the matrix-vector product
  const inbound = new Map<string, string[]>();
  const outdeg = new Map<string, number>();
  for (const [src, outs] of graph.edges) {
    outdeg.set(src, outs.size);
    for (const dst of outs) {
      const list = inbound.get(dst) ?? [];
      list.push(src);
      inbound.set(dst, list);
    }
  }

  const teleport = (1 - PAGERANK_DAMPING) / N;
  for (let iter = 0; iter < PAGERANK_ITERS; iter++) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const [name, r] of rank) {
      const od = outdeg.get(name) ?? 0;
      if (od === 0) dangling += r;
    }
    const danglingShare = (PAGERANK_DAMPING * dangling) / N;
    for (const name of graph.defs.keys()) {
      let inc = 0;
      const ins = inbound.get(name) ?? [];
      for (const src of ins) {
        const od = outdeg.get(src) ?? 0;
        if (od === 0) continue;
        inc += (rank.get(src) ?? 0) / od;
      }
      next.set(name, teleport + danglingShare + PAGERANK_DAMPING * inc);
    }
    rank = next;
  }
  return rank;
}

function topFacts(rank: Map<string, number>, graph: Graph, ctx: ExtractContext): NewFact[] {
  const sorted = [...rank.entries()]
    .filter(([name]) => !containsSecret(name))
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .slice(0, TOP_N_FACTS);
  return sorted.map(([name, score]) =>
    structuredFact({
      subject: "repo",
      predicate: "importance",
      object: { symbol: name, file: graph.defs.get(name) ?? "?", score: round4(score) },
      fact_kind: "semantic",
      temporal_kind: "static",
      scope: ctx.scope,
      confidence: 0.7,
      tags: ["repo-map", "pagerank"],
      rawQuote: `${name} ranks high in the workspace symbol graph`,
      git: {
        repo_id: ctx.repoId,
        branch: ctx.branch,
        valid_from_commit: ctx.head,
        path_globs: [graph.defs.get(name) ?? "?"],
      },
    }),
  );
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

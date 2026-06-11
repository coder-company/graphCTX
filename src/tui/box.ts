// Dependency-free box drawing, tables, bars, and badges built on ansi.ts.

import { padEnd, padStart, style, truncate, visibleLen } from "./ansi.js";

const B = {
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  h: "─",
  v: "│",
  ml: "├",
  mr: "┤",
};

export interface PanelOpts {
  title?: string;
  width?: number;
  color?: (s: string) => string;
}

// Render a bordered panel around pre-wrapped lines. Lines are truncated to fit.
export function panel(lines: string[], opts: PanelOpts = {}): string {
  const width = opts.width ?? 78;
  const inner = width - 2;
  const color = opts.color ?? ((s: string) => s);
  const out: string[] = [];
  const titleStr = opts.title ? ` ${opts.title} ` : "";
  const titleLen = visibleLen(titleStr);
  const left = 2;
  const right = Math.max(0, inner - left - titleLen);
  out.push(color(B.tl + B.h.repeat(left)) + style.bold(titleStr) + color(B.h.repeat(right) + B.tr));
  const content = inner - 1; // border + leading space + content + border
  for (const line of lines) {
    const cut = visibleLen(line) > content ? truncate(line, content) : line;
    out.push(`${color(B.v)} ${padEnd(cut, content)}${color(B.v)}`);
  }
  out.push(color(B.bl + B.h.repeat(inner) + B.br));
  return out.join("\n");
}

// A horizontal separator line inside a panel width.
export function rule(width = 78, color: (s: string) => string = style.gray): string {
  return color(B.h.repeat(width));
}

export interface Column {
  header: string;
  width: number;
  align?: "left" | "right";
}

// Render a simple table. Cells may already be styled.
export function table(cols: Column[], rows: string[][]): string[] {
  const out: string[] = [];
  const headerCells = cols.map((c) =>
    c.align === "right"
      ? padStart(style.bold(style.gray(c.header)), c.width)
      : padEnd(style.bold(style.gray(c.header)), c.width),
  );
  out.push(headerCells.join("  "));
  for (const row of rows) {
    const cells = row.map((cell, i) => {
      const c = cols[i];
      if (!c) return cell;
      const v = visibleLen(cell) > c.width ? truncate(cell, c.width) : cell;
      return c.align === "right" ? padStart(v, c.width) : padEnd(v, c.width);
    });
    out.push(cells.join("  "));
  }
  return out;
}

// A unicode mini bar (0..1) of a given cell width.
export function bar(fraction: number, width = 20, color = style.green): string {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return color("█".repeat(filled)) + style.gray("░".repeat(width - filled));
}

// A small colored badge.
export function badge(label: string, kind: "ok" | "warn" | "err" | "info" = "info"): string {
  const map = {
    ok: style.bgGreen,
    warn: (s: string) => style.bgGray(style.yellow(s)),
    err: style.bgRed,
    info: style.bgBlue,
  } as const;
  return map[kind](style.bold(` ${label} `));
}

export function kv(label: string, value: string, labelWidth = 18): string {
  return style.gray(padEnd(`${label}:`, labelWidth)) + value;
}

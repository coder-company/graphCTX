// graphCTX TUI — dependency-free interactive terminal UI.
// Three modes (tabs): Dashboard (read-only), Control (actions), Monitor (live).
// Built on raw ANSI + readline; honors NO_COLOR and non-TTY.

import { renderCard } from "../render/cards.js";
import { Runtime } from "../runtime.js";
import { assertSafeMemoryWrite } from "../security/intake.js";
import { safeForSend } from "../security/send-edge.js";
import { padEnd, style, term, truncate, visibleLen } from "./ansi.js";
import { type Column, badge, bar, kv, panel, table } from "./box.js";
import { type FactView, type MemoryStats, factViews, memoryStats } from "./data.js";
import { type Key, readKeys } from "./keys.js";

type Tab = "dashboard" | "control" | "monitor";
const TABS: Tab[] = ["dashboard", "control", "monitor"];
type RecentColumn = Column & { key: "id" | "kind" | "scope" | "status" | "fact" };

interface AppState {
  tab: Tab;
  cursor: number; // selected row in the current list
  scroll: number;
  filter: "all" | "active" | "candidate" | "open_loop" | "secret";
  status: string; // transient status line
  monitorLog: string[];
  prompt: { active: boolean; label: string; value: string; onSubmit: (v: string) => void } | null;
}

export class TuiApp {
  private rt: Runtime;
  private state: AppState;
  private reader?: { stop(): void };
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(workspaceDir: string, initial: Tab = "dashboard") {
    this.rt = new Runtime({ workspaceDir });
    this.state = {
      tab: initial,
      cursor: 0,
      scroll: 0,
      filter: "all",
      status: "",
      monitorLog: [],
      prompt: null,
    };
  }

  // Non-interactive fallback: print a one-shot dashboard snapshot and exit.
  snapshot(): string {
    if (this.state.tab === "control") return this.renderControl().join("\n");
    if (this.state.tab === "monitor") return this.renderMonitor().join("\n");
    return this.renderDashboard().join("\n");
  }

  close(): void {
    this.rt.close();
  }

  async run(): Promise<void> {
    if (!process.stdout.isTTY) {
      process.stdout.write(`${this.snapshot()}\n`);
      this.rt.close();
      return;
    }
    this.running = true;
    term.altScreen(true);
    term.hideCursor();
    this.reader = readKeys((k) => this.onKey(k));
    // Live refresh for the monitor tab.
    this.timer = setInterval(() => {
      if (this.state.tab === "monitor") this.draw();
    }, 1000);
    this.draw();
    await new Promise<void>((resolve) => {
      this.onExit = resolve;
    });
  }

  private onExit: () => void = () => {};

  private quit(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.reader?.stop();
    term.showCursor();
    term.altScreen(false);
    this.rt.close();
    this.onExit();
  }

  private onKey(k: Key): void {
    if (this.state.prompt?.active) {
      this.handlePromptKey(k);
      return;
    }
    if (k.name === "q" || k.name === "ctrl-c" || k.name === "escape") {
      this.quit();
      return;
    }
    if (k.name === "tab" || k.raw === "\t") {
      this.cycleTab(1);
      return;
    }
    if (k.name === "1") this.setTab("dashboard");
    else if (k.name === "2") this.setTab("control");
    else if (k.name === "3") this.setTab("monitor");
    else if (k.name === "up") this.move(-1);
    else if (k.name === "down") this.move(1);
    else if (k.name === "f") this.cycleFilter();
    else if (k.name === "r") this.refresh("refreshed");
    else if (this.state.tab === "control") this.onControlKey(k);
    else if (this.state.tab === "monitor") this.onMonitorKey(k);
    this.draw();
  }

  private handlePromptKey(k: Key): void {
    const p = this.state.prompt;
    if (!p) return;
    if (k.name === "return") {
      const v = p.value.trim();
      this.state.prompt = null;
      if (v) p.onSubmit(v);
      this.draw();
      return;
    }
    if (k.name === "escape") {
      this.state.prompt = null;
      this.state.status = "cancelled";
      this.draw();
      return;
    }
    if (k.name === "backspace") {
      p.value = p.value.slice(0, -1);
    } else if (k.raw.length === 1 && k.raw >= " ") {
      p.value += k.raw;
    }
    this.draw();
  }

  private ask(label: string, onSubmit: (v: string) => void): void {
    this.state.prompt = { active: true, label, value: "", onSubmit };
  }

  private onControlKey(k: Key): void {
    const views = this.currentViews();
    const sel = views[this.state.cursor];
    if (k.name === "n") {
      this.ask("New fact (remember)", (v) => {
        try {
          assertSafeMemoryWrite(v);
        } catch {
          this.refresh("refused secret-bearing memory");
          return;
        }
        void this.rt.rememberFact({ text: v }).then((f) => {
          this.refresh(`remembered ${f.fact_id.slice(-8)}`);
          this.draw();
        });
      });
    } else if (k.name === "o") {
      this.ask("New open loop", (v) => {
        try {
          assertSafeMemoryWrite(v);
        } catch {
          this.refresh("refused secret-bearing open loop");
          return;
        }
        void this.rt.noteOpenLoop(v).then((f) => {
          this.refresh(`open loop ${f.fact_id.slice(-8)}`);
          this.draw();
        });
      });
    } else if (k.name === "x" && sel) {
      // Close the temporal window, preserving `why` provenance.
      void this.rt.forgetFact(sel.fact.fact_id).then(() => {
        this.refresh(`forgot ${sel.id8}`);
        this.draw();
      });
    } else if (k.name === "p" && sel) {
      void this.rt.reviewFactForWorkspace(sel.fact.fact_id).then((review) => {
        if (!review) {
          this.refresh(`missing ${sel.id8}`);
        } else if (review.decision.kind === "promote") {
          this.refresh(`promoted ${sel.id8} via ${review.decision.gate}`);
        } else {
          this.refresh(`${review.decision.kind} ${sel.id8}: ${review.decision.gate}`);
        }
        this.draw();
      });
    } else if (k.name === "return" && sel?.fact.fact_kind === "open_loop") {
      void this.rt
        .resolveOpenLoop(sel.fact.fact_id)
        .then(() => this.refresh(`resolved ${sel.id8}`));
    }
  }

  private onMonitorKey(k: Key): void {
    if (k.name === "s") {
      // simulate a SessionStart push to see the live capsule
      void this.simulatePush("SessionStart");
    } else if (k.name === "c") {
      void this.simulatePush("PostCompact");
    }
  }

  private async simulatePush(event: "SessionStart" | "PostCompact"): Promise<void> {
    try {
      const ctx = await this.rt.injectionContext(event, "tui-monitor", { budget_tokens: 1500 });
      const capsule = await this.rt.planner().plan(ctx);
      const ts = new Date().toLocaleTimeString();
      const n = capsule.cards.length;
      this.state.monitorLog.unshift(
        `${style.gray(ts)} ${badge(event, "info")} → ${n} card(s), ${capsule.token_count} tok`,
      );
      for (const line of capsule.markdown.split("\n").filter(Boolean).slice(0, 6)) {
        this.state.monitorLog.unshift(`   ${style.dim(truncate(line, 70))}`);
      }
      this.state.monitorLog = this.state.monitorLog.slice(0, 200);
    } catch (e) {
      this.state.monitorLog.unshift(style.red(`error: ${(e as Error).message}`));
    }
    this.draw();
  }

  private setTab(t: Tab): void {
    this.state.tab = t;
    this.state.cursor = 0;
    this.state.scroll = 0;
  }

  private cycleTab(dir: number): void {
    const i = TABS.indexOf(this.state.tab);
    this.setTab(TABS[(i + dir + TABS.length) % TABS.length] as Tab);
  }

  private cycleFilter(): void {
    const order: AppState["filter"][] = ["all", "active", "candidate", "open_loop", "secret"];
    const i = order.indexOf(this.state.filter);
    this.state.filter = order[(i + 1) % order.length] as AppState["filter"];
    this.state.cursor = 0;
  }

  private move(d: number): void {
    const max = this.currentViews().length - 1;
    this.state.cursor = Math.max(0, Math.min(max, this.state.cursor + d));
    this.state.scroll = clampWindowStart(
      this.state.cursor,
      this.state.scroll,
      max + 1,
      this.controlPageSize(max >= 0),
    );
  }

  private refresh(status?: string): void {
    if (status) this.state.status = status;
  }

  private currentViews(): FactView[] {
    const f = this.state.filter;
    return factViews(this.rt, (fact) => {
      if (f === "all") return true;
      if (f === "active") return fact.status === "active";
      if (f === "candidate") return fact.status === "candidate";
      if (f === "open_loop") return fact.fact_kind === "open_loop";
      if (f === "secret") return fact.sensitivity === "secret" || fact.sensitivity === "credential";
      return true;
    });
  }

  private draw(): void {
    if (!this.running) return;
    term.clear();
    let lines: string[];
    if (this.state.tab === "dashboard") lines = this.renderDashboard();
    else if (this.state.tab === "control") lines = this.renderControl();
    else lines = this.renderMonitor();
    process.stdout.write(`${this.header()}\n${lines.join("\n")}\n${this.footer()}`);
  }

  private header(): string {
    const tabs = TABS.map((t, i) => {
      const label = ` ${i + 1} ${t} `;
      return t === this.state.tab ? style.inverse(style.bold(label)) : style.gray(label);
    }).join(style.gray("│"));
    const title = style.bold(style.cyan(" graphCTX "));
    return `${title}${tabs}`;
  }

  private footer(): string {
    if (this.state.prompt?.active) {
      const p = this.state.prompt;
      return `\n${style.bold(style.yellow(`${p.label}: `))}${p.value}${style.inverse(" ")}  ${style.gray("(enter=ok esc=cancel)")}`;
    }
    const parts = ["tab/1-3 switch", "up/down move", "f filter", "r refresh", "q quit"];
    if (this.state.tab === "control") {
      parts.push("n new", "o open-loop", "p promote", "x forget", "enter resolve");
    } else if (this.state.tab === "monitor") {
      parts.push("s SessionStart", "c PostCompact");
    }
    const styledParts = parts.map((part) => style.gray(part));
    if (this.state.status) styledParts.push(style.green(`ok ${this.state.status}`));
    return `\n${wrapFooterParts(styledParts, this.contentWidth()).join("\n")}`;
  }

  private renderDashboard(): string[] {
    const s = memoryStats(this.rt);
    const width = this.contentWidth();
    const out: string[] = [];
    out.push("");
    out.push(...this.statsPanel(s, width));
    out.push("");
    const views = this.currentViews().slice(0, 12);
    const cols = recentColumns(width);
    out.push(style.bold(`Recent memory (filter: ${this.state.filter})`));
    out.push(
      ...table(
        cols,
        views.map((v) => cols.map((col) => this.recentCell(v, col))),
      ),
    );
    if (views.length === 0) out.push(style.gray("  (no facts — run `graphctx init` or `extract`)"));
    return out;
  }

  private statsPanel(s: MemoryStats, width: number): string[] {
    const left = [
      kv("Total facts", style.bold(String(s.total))),
      kv("Active", style.green(String(s.active))),
      kv("Candidates", style.yellow(String(s.candidate))),
      kv("Open loops", style.cyan(String(s.openLoops))),
      kv("Procedures", String(s.procedures)),
      kv("Secrets guarded", s.secrets > 0 ? style.red(String(s.secrets)) : "0"),
    ];
    const total = Math.max(1, s.byScope.session + s.byScope.workspace + s.byScope.user);
    const right = [
      style.bold("Scope distribution"),
      `session   ${bar(s.byScope.session / total, 16, style.gray)} ${s.byScope.session}`,
      `workspace ${bar(s.byScope.workspace / total, 16, style.blue)} ${s.byScope.workspace}`,
      `user      ${bar(s.byScope.user / total, 16, style.magenta)} ${s.byScope.user}`,
      "",
      `trust: ${style.green(`high ${s.byTrust.high}`)}  ${style.yellow(`low ${s.byTrust.low}`)}`,
    ];
    const rows: string[] = [];
    const h = Math.max(left.length, right.length);
    for (let i = 0; i < h; i++) {
      rows.push(`${padEnd(left[i] ?? "", 38)}${right[i] ?? ""}`);
    }
    return [panel(rows, { title: "Memory overview", width, color: style.cyan })];
  }

  private renderControl(): string[] {
    const views = this.currentViews();
    const width = this.contentWidth();
    const selected = views[this.state.cursor];
    const pageSize = this.controlPageSize(Boolean(selected));
    this.state.scroll = clampWindowStart(
      this.state.cursor,
      this.state.scroll,
      views.length,
      pageSize,
    );
    const start = views.length === 0 ? 0 : this.state.scroll + 1;
    const end = Math.min(views.length, this.state.scroll + pageSize);
    const out: string[] = [];
    out.push("");
    out.push(
      style.bold(
        `Control panel - ${views.length} facts (filter: ${this.state.filter}, rows ${start}-${end})`,
      ),
    );
    out.push(style.gray("Select a row, then act. Enter resolves an open loop."));
    out.push("");
    const win = views.slice(this.state.scroll, this.state.scroll + pageSize);
    win.forEach((v, i) => {
      const idx = this.state.scroll + i;
      const sel = idx === this.state.cursor;
      out.push(this.controlRow(v, sel, width));
    });
    if (views.length === 0) out.push(style.gray("  (nothing to manage)"));
    if (selected) {
      out.push("");
      out.push(this.selectedFactPanel(selected, width));
    }
    return out;
  }

  private renderMonitor(): string[] {
    const out: string[] = [];
    out.push("");
    out.push(style.bold("Live push monitor"));
    out.push(
      style.gray("Press s/c to simulate a push and watch the exact capsule the agent receives."),
    );
    out.push("");
    if (this.state.monitorLog.length === 0) {
      out.push(style.gray("  (no pushes yet — press 's' for SessionStart, 'c' for PostCompact)"));
    } else {
      out.push(...this.state.monitorLog.slice(0, 18));
    }
    return out;
  }

  private kindColor(kind: string): string {
    if (kind === "open_loop") return style.cyan(kind);
    if (kind === "procedural") return style.magenta(kind);
    if (kind === "failure" || kind === "constraint") return style.yellow(kind);
    return kind;
  }

  private statusColor(s: string): string {
    if (s === "active") return style.green(s);
    if (s === "candidate") return style.yellow(s);
    if (s === "expired" || s === "rejected" || s === "superseded") return style.gray(s);
    if (s === "disputed") return style.red(s);
    return s;
  }

  private controlPageSize(hasDetail: boolean): number {
    // Header/footer/title/help plus the selected-detail panel consume vertical
    // space. Keep enough rows for control mode to stay useful in short terminals
    // while scaling up smoothly.
    const reserved = hasDetail ? 16 : 8;
    return Math.max(4, Math.min(20, term.height() - reserved));
  }

  private contentWidth(): number {
    return clampTuiWidth(term.width());
  }

  private recentCell(v: FactView, col: RecentColumn): string {
    if (col.key === "id") return style.gray(v.id8);
    if (col.key === "kind") return this.kindColor(v.kind);
    if (col.key === "scope") return v.scope;
    if (col.key === "status") return this.statusColor(v.status);
    return truncate(v.text, col.width);
  }

  private controlRow(v: FactView, selected: boolean, width: number): string {
    const marker = selected ? style.cyan("> ") : "  ";
    const id = style.gray(`  [${v.id8}]`);
    if (width < 64) {
      const textWidth = Math.max(6, width - 24);
      const row = `${padEnd(this.statusColor(v.status), 9)} ${truncate(v.text, textWidth)}`;
      return marker + (selected ? style.bold(row) : row) + id;
    }
    const textWidth = Math.max(12, width - 36);
    const row = `${padEnd(this.kindColor(v.kind), 11)} ${padEnd(this.statusColor(v.status), 10)} ${truncate(v.text, textWidth)}`;
    return marker + (selected ? style.bold(row) : row) + id;
  }

  private selectedFactPanel(v: FactView, width: number): string {
    const confidence =
      typeof v.fact.confidence === "number" ? v.fact.confidence.toFixed(2) : "unknown";
    const observed = v.fact.time?.t_observed ?? v.fact.time?.t_recorded ?? "unknown";
    const meta = [
      `kind ${v.kind}`,
      `scope ${v.scope}`,
      `status ${v.status}`,
      `trust ${v.trust}`,
      `sensitivity ${v.fact.sensitivity ?? "unknown"}`,
    ].join("  ");
    const lines = [
      meta,
      `confidence ${confidence}  evidence ${v.fact.evidence_count ?? 0}  source ${v.fact.source.asserted_by}`,
      `observed ${observed}`,
      "",
      truncate(v.text, Math.max(12, width - 4)),
    ];
    return panel(lines, { title: `Selected ${v.id8}`, width, color: style.blue });
  }
}

export function clampTuiWidth(columns: number): number {
  const safe = Number.isFinite(columns) ? Math.floor(columns) : 80;
  return Math.max(40, Math.min(112, safe));
}

function recentColumns(width: number): RecentColumn[] {
  const safe = clampTuiWidth(width);
  if (safe < 70) {
    const factWidth = Math.max(10, safe - 21);
    return [
      { key: "id", header: "id", width: 8 },
      { key: "status", header: "status", width: 9 },
      { key: "fact", header: "fact", width: factWidth },
    ];
  }
  return [
    { key: "id", header: "id", width: 8 },
    { key: "kind", header: "kind", width: 11 },
    { key: "scope", header: "scope", width: 9 },
    { key: "status", header: "status", width: 10 },
    { key: "fact", header: "fact", width: Math.max(16, safe - 46) },
  ];
}

export function wrapFooterParts(parts: string[], width: number): string[] {
  const safe = clampTuiWidth(width);
  const gap = style.gray(" | ");
  const lines: string[] = [];
  let line = "";
  for (const part of parts) {
    const next = line ? `${line}${gap}${part}` : part;
    if (line && visibleLen(next) > safe) {
      lines.push(line);
      line = part;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

export function clampWindowStart(
  cursor: number,
  currentStart: number,
  total: number,
  pageSize: number,
): number {
  if (total <= 0) return 0;
  const page = Math.max(1, pageSize);
  const maxStart = Math.max(0, total - page);
  const clampedCursor = Math.max(0, Math.min(total - 1, cursor));
  if (clampedCursor < currentStart) return Math.min(clampedCursor, maxStart);
  if (clampedCursor >= currentStart + page) return Math.min(maxStart, clampedCursor - page + 1);
  return Math.min(Math.max(0, currentStart), maxStart);
}

// Convenience used by the CLI: render a one-shot card list (no raw mode).
export function renderFactList(rt: Runtime): string {
  return factViews(rt)
    .filter((v) => safeForSend(v.fact))
    .map((v) => renderCard(v.fact).markdown)
    .join("\n");
}

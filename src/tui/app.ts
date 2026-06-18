// graphCTX TUI — dependency-free interactive terminal UI.
// Three modes (tabs): Dashboard (read-only), Control (actions), Monitor (live).
// Built on raw ANSI + readline; honors NO_COLOR and non-TTY.

import { renderCard } from "../render/cards.js";
import { Runtime } from "../runtime.js";
import { assertSafeMemoryWrite } from "../security/intake.js";
import { safeForSend } from "../security/send-edge.js";
import { padEnd, style, term, truncate } from "./ansi.js";
import { badge, bar, kv, panel, table } from "./box.js";
import { type FactView, type MemoryStats, factViews, memoryStats } from "./data.js";
import { type Key, readKeys } from "./keys.js";

type Tab = "dashboard" | "control" | "monitor";
const TABS: Tab[] = ["dashboard", "control", "monitor"];

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
    return this.renderDashboard().join("\n");
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
    const common = "tab/1-3 switch · ↑↓ move · f filter · r refresh · q quit";
    const extra =
      this.state.tab === "control"
        ? " · n new · o open-loop · p promote · x forget · ⏎ resolve"
        : this.state.tab === "monitor"
          ? " · s SessionStart · c PostCompact"
          : "";
    const status = this.state.status ? `  ${style.green(`✓ ${this.state.status}`)}` : "";
    return `\n${style.gray(common + extra)}${status}`;
  }

  private renderDashboard(): string[] {
    const s = memoryStats(this.rt);
    const out: string[] = [];
    out.push("");
    out.push(...this.statsPanel(s));
    out.push("");
    const views = this.currentViews().slice(0, 12);
    out.push(style.bold(`Recent memory (filter: ${this.state.filter})`));
    out.push(
      ...table(
        [
          { header: "id", width: 8 },
          { header: "kind", width: 11 },
          { header: "scope", width: 9 },
          { header: "status", width: 10 },
          { header: "fact", width: 40 },
        ],
        views.map((v) => [
          style.gray(v.id8),
          this.kindColor(v.kind),
          v.scope,
          this.statusColor(v.status),
          truncate(v.text, 40),
        ]),
      ),
    );
    if (views.length === 0) out.push(style.gray("  (no facts — run `graphctx init` or `extract`)"));
    return out;
  }

  private statsPanel(s: MemoryStats): string[] {
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
    return [panel(rows, { title: "Memory overview", width: 78, color: style.cyan })];
  }

  private renderControl(): string[] {
    const views = this.currentViews();
    const out: string[] = [];
    out.push("");
    out.push(style.bold(`Control panel — ${views.length} facts (filter: ${this.state.filter})`));
    out.push(style.gray("Select a row, then act. ⏎ resolves an open loop."));
    out.push("");
    const win = views.slice(this.state.scroll, this.state.scroll + 16);
    win.forEach((v, i) => {
      const idx = this.state.scroll + i;
      const sel = idx === this.state.cursor;
      const marker = sel ? style.cyan("❯ ") : "  ";
      const row = `${padEnd(this.kindColor(v.kind), 11)} ${padEnd(this.statusColor(v.status), 10)} ${truncate(v.text, 46)}`;
      out.push(marker + (sel ? style.bold(row) : row) + style.gray(`  [${v.id8}]`));
    });
    if (views.length === 0) out.push(style.gray("  (nothing to manage)"));
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
}

// Convenience used by the CLI: render a one-shot card list (no raw mode).
export function renderFactList(rt: Runtime): string {
  return factViews(rt)
    .filter((v) => safeForSend(v.fact))
    .map((v) => renderCard(v.fact).markdown)
    .join("\n");
}

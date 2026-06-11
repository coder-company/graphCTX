// Dependency-free ANSI styling + terminal primitives. No framework: keeps
// graphCTX true to its minimal-dependency thesis (no ink/blessed/react).
// Honors NO_COLOR and non-TTY (pipes) by degrading to plain text.

const NO_COLOR = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "";
const isTTY = Boolean(process.stdout.isTTY);
export const colorEnabled = isTTY && !NO_COLOR;

function wrap(open: number, close: number) {
  return (s: string): string => (colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const style = {
  reset: "\x1b[0m",
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
  black: wrap(30, 39),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  white: wrap(37, 39),
  gray: wrap(90, 39),
  bgBlue: wrap(44, 49),
  bgGreen: wrap(42, 49),
  bgRed: wrap(41, 49),
  bgGray: wrap(100, 49),
};

// Cursor / screen control (only emitted on a TTY).
export const term = {
  clear: () => {
    if (isTTY) process.stdout.write("\x1b[2J\x1b[H");
  },
  hideCursor: () => {
    if (isTTY) process.stdout.write("\x1b[?25l");
  },
  showCursor: () => {
    if (isTTY) process.stdout.write("\x1b[?25h");
  },
  moveHome: () => {
    if (isTTY) process.stdout.write("\x1b[H");
  },
  clearLine: () => {
    if (isTTY) process.stdout.write("\x1b[2K");
  },
  altScreen: (on: boolean) => {
    if (isTTY) process.stdout.write(on ? "\x1b[?1049h" : "\x1b[?1049l");
  },
  width: () => process.stdout.columns ?? 80,
  height: () => process.stdout.rows ?? 24,
};

// Visible length, ignoring ANSI escape sequences.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI codes by design
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function visibleLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// Pad a (possibly styled) string to a visible width, left-aligned.
export function padEnd(s: string, width: number): string {
  const len = visibleLen(s);
  return len >= width ? s : s + " ".repeat(width - len);
}

export function padStart(s: string, width: number): string {
  const len = visibleLen(s);
  return len >= width ? s : " ".repeat(width - len) + s;
}

// Truncate to a visible width, appending an ellipsis if cut.
export function truncate(s: string, width: number): string {
  if (visibleLen(s) <= width) return s;
  if (width <= 1) return "…";
  // Truncation on styled strings: strip, cut, then it renders plain. Callers
  // that need color should style AFTER truncating.
  const plain = stripAnsi(s);
  return `${plain.slice(0, width - 1)}…`;
}

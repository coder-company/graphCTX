// Minimal raw-mode keypress reader. No deps; uses Node's tty + stdin.

export interface Key {
  name: string; // 'up','down','left','right','return','escape','q', single chars, etc.
  ctrl: boolean;
  raw: string;
}

export type KeyHandler = (key: Key) => void;

export function decodeKey(raw: string): Key {
  const ctrl = raw.length === 1 && raw.charCodeAt(0) < 27 && raw !== "\r" && raw !== "\n";
  let name = raw;
  switch (raw) {
    case "\x1b[A":
      name = "up";
      break;
    case "\x1b[B":
      name = "down";
      break;
    case "\x1b[C":
      name = "right";
      break;
    case "\x1b[D":
      name = "left";
      break;
    case "\x1b[5~":
      name = "pageup";
      break;
    case "\x1b[6~":
      name = "pagedown";
      break;
    case "\x1b[H":
    case "\x1b[1~":
      name = "home";
      break;
    case "\x1b[F":
    case "\x1b[4~":
      name = "end";
      break;
    case "\r":
    case "\n":
      name = "return";
      break;
    case "\x1b":
      name = "escape";
      break;
    case "\x7f":
    case "\b":
      name = "backspace";
      break;
    case "\x03":
      name = "ctrl-c";
      break;
    case " ":
      name = "space";
      break;
    default:
      name = raw;
  }
  return { name, ctrl, raw };
}

const ESCAPE_SEQUENCES = [
  "\x1b[5~",
  "\x1b[6~",
  "\x1b[1~",
  "\x1b[4~",
  "\x1b[A",
  "\x1b[B",
  "\x1b[C",
  "\x1b[D",
  "\x1b[H",
  "\x1b[F",
  "\x1b",
];

export function decodeKeyChunk(raw: string): Key[] {
  const keys: Key[] = [];
  for (let i = 0; i < raw.length; ) {
    const seq = ESCAPE_SEQUENCES.find((candidate) => raw.startsWith(candidate, i));
    if (seq) {
      keys.push(decodeKey(seq));
      i += seq.length;
    } else {
      keys.push(decodeKey(raw[i] as string));
      i += 1;
    }
  }
  return keys;
}

export interface KeyReader {
  stop(): void;
}

// Start reading keys; returns a stop() to restore the terminal. No-op (returns
// a stub) when stdin is not a TTY so piped/non-interactive runs don't hang.
export function readKeys(onKey: KeyHandler): KeyReader {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return { stop: () => {} };
  }
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  const listener = (chunk: string) => {
    for (const key of decodeKeyChunk(chunk)) onKey(key);
  };
  stdin.on("data", listener);
  return {
    stop: () => {
      stdin.removeListener("data", listener);
      try {
        stdin.setRawMode(false);
      } catch {
        // ignore
      }
      stdin.pause();
    },
  };
}

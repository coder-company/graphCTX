// Minimal raw-mode keypress reader. No deps; uses Node's tty + stdin.

export interface Key {
  name: string; // 'up','down','left','right','return','escape','q', single chars, etc.
  ctrl: boolean;
  raw: string;
}

export type KeyHandler = (key: Key) => void;

function decode(raw: string): Key {
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
    // A chunk may contain multiple keypresses; emit escape sequences whole.
    if (chunk.startsWith("\x1b[") || chunk === "\x1b") {
      onKey(decode(chunk));
      return;
    }
    for (const ch of chunk) onKey(decode(ch));
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

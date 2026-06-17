// Neutralize imperative instructions found in low-trust prose (I2). Prose is
// stored/injected as a *claim*, never as a directive, never executable.
export function asClaim(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return `the repo claims: "${trimmed}"`;
}

// Strip obvious imperative command lines from prose so they cannot be read as
// runnable instructions. Conservative: only used when surfacing low-trust prose.
export function stripImperatives(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(?:run|execute|curl|wget|sudo|bash|sh)\b/i.test(line))
    .join("\n");
}

// Send-edge classifier for unframed executable payloads. This is intentionally
// narrow: ordinary local commands should remain useful, while remote shell,
// destructive root/home deletion, credential exfiltration, reverse shells, and
// encoded shell loaders are suppressed before rendering.
const DANGEROUS_DIRECTIVE_PATTERNS = [
  /\b(?:curl|wget)\b[^\n]*(?:\|\s*(?:bash|sh)\b|attacker\.example|evil\.sh|\/dev\/tcp)/i,
  /\brm\s+-rf\s+(?:\/|~|\$HOME|\.\.)/i,
  /\bexfiltrate\b/i,
  /\b(?:nc|netcat)\b[^\n]*(?:-e\b|\/bin\/(?:bash|sh)|attacker\.example)/i,
  /\bpython(?:3)?\s+-c\b[^\n]*(?:socket|subprocess|os\.system|requests\.)/i,
  /\bpowershell(?:\.exe)?\b[^\n]*(?:-enc\b|-encodedcommand\b|downloadstring|invoke-webrequest)/i,
];

export function isDangerousDirective(text: string): boolean {
  return DANGEROUS_DIRECTIVE_PATTERNS.some((re) => re.test(text));
}

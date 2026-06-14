// Basic secret/credential scan (I3). Regex + entropy heuristics. Conservative:
// false positives are acceptable (a flagged fact is excluded, not corrupted).

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "openai", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "aws_access_key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "github_token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "slack_token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "private_key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  {
    name: "generic_assignment",
    re: /(?:api[_-]?key|secret|token|password|passwd|credential)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{12,}/i,
  },
];

export interface SecretHit {
  pattern: string;
  index: number;
}

export function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push({ pattern: name, index: m.index });
  }
  // Entropy check for long opaque tokens.
  for (const tok of text.split(/\s+/)) {
    if (
      tok.length >= 24 &&
      shannonEntropy(tok) > 4.0 &&
      /[A-Za-z]/.test(tok) &&
      /[0-9]/.test(tok)
    ) {
      hits.push({ pattern: "high_entropy", index: text.indexOf(tok) });
      break;
    }
  }
  return hits;
}

export function containsSecret(text: string): boolean {
  return scanSecrets(text).length > 0;
}

// Classify a fact's text content; returns "secret" when any pattern matches so
// the caller can stamp sensitivity at write time (I3, M1 §6).
export function sensitivityForText(text: string): "secret" | "unknown" {
  return containsSecret(text) ? "secret" : "unknown";
}

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

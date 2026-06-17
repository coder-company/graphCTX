// Basic secret/credential scan (I3). Regex + entropy heuristics. Conservative:
// false positives are acceptable (a flagged fact is excluded, not corrupted).

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "openai", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "aws_access_key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "github_token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "github_fine_grained_pat", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "gitlab_pat", re: /glpat-[A-Za-z0-9_-]{16,}/ },
  { name: "npm_token", re: /npm_[A-Za-z0-9]{20,}/ },
  { name: "stripe_secret_key", re: /sk_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: "slack_token", re: /xox[abcrps]-[A-Za-z0-9-]{10,}/ },
  { name: "private_key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  {
    name: "generic_assignment",
    re: /(?:api[_-]?key|secret|token|password|passwd|credential)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{12,}/i,
  },
  {
    // Long hex secret (>=40 hex) appearing next to a credential keyword. The
    // adjacent keyword keeps this precise: a bare git SHA-1 ("commit <40hex>")
    // has no secret keyword, so legitimate hashes are NOT flagged. Without this
    // context requirement we could not distinguish a 40-hex token from a git
    // SHA without unacceptable false positives.
    name: "hex_secret_in_context",
    re: /(?:api[_-]?key|secret|token|password|passwd|credential)[\w.-]*\s*[:=]?\s*['"]?[0-9a-f]{40,}/i,
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
  for (const raw of text.split(/\s+/)) {
    const tok = raw.replace(/^[`'"]+|[`'",;]+$/g, "");
    if (isBenignOpaqueToken(tok)) continue;
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

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const { name, re } of SECRET_PATTERNS) {
    redacted = redacted.replace(globalize(re), `[REDACTED:${name}]`);
  }
  for (const raw of redacted.split(/\s+/)) {
    const tok = raw.replace(/^[`'"]+|[`'",;]+$/g, "");
    if (isBenignOpaqueToken(tok)) continue;
    if (
      tok.length >= 24 &&
      shannonEntropy(tok) > 4.0 &&
      /[A-Za-z]/.test(tok) &&
      /[0-9]/.test(tok)
    ) {
      redacted = redacted.replace(escapeRegExp(tok), "[REDACTED:high_entropy]");
    }
  }
  return redacted;
}

export function redactSecretValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (value === null || value === undefined) return value;
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value)));
  } catch {
    return "[REDACTED]";
  }
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

function isBenignOpaqueToken(s: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*=\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.]+)?$/.test(s) ||
    /^sha\d+-[A-Za-z0-9+/=]{8,}$/i.test(s)
  );
}

function globalize(re: RegExp): RegExp {
  const flags = new Set(re.flags.split(""));
  flags.add("g");
  return new RegExp(re.source, [...flags].join(""));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

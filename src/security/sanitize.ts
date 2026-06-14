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

// Content-based secret detection (SPEC §Security). File names can lie; content
// can't. Results name the pattern that matched, never the matched text, so
// they are safe to log.

export interface SecretPattern {
  name: string;
  re: RegExp;
}

/**
 * Always applied, from v0.1: a file with any of these is never skeletoned,
 * cached or summarized. Covers PKCS#1/#8 (`RSA`, `EC`, `DSA`, plain,
 * `ENCRYPTED`), `OPENSSH`, and PGP private key blocks.
 */
export const PRIVATE_KEY_PATTERNS: readonly SecretPattern[] = [
  { name: "private-key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
];

export interface SecretHit {
  pattern: string;
  /** 1-based line of the first match. */
  line: number;
}

/** Scans text for secret patterns; returns one hit per pattern that matched. */
export function scanForSecrets(text: string, patterns: readonly SecretPattern[] = PRIVATE_KEY_PATTERNS): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { name, re } of patterns) {
    const m = re.exec(text);
    if (m) hits.push({ pattern: name, line: text.slice(0, m.index).split("\n").length });
  }
  return hits;
}

// Content-based secret detection (SPEC §Security). File names can lie; content
// can't. Results name the pattern that matched, never the matched text, so
// they are safe to log.

export interface SecretPattern {
  name: string;
  re: RegExp;
  /** Return false to ignore a match (e.g. an obvious placeholder). */
  accept?: (match: RegExpExecArray) => boolean;
}

/**
 * Always applied, from v0.1: a file with any of these is never skeletoned,
 * cached, served or summarized. Covers PKCS#1/#8 (`RSA`, `EC`, `DSA`, plain,
 * `ENCRYPTED`), `OPENSSH`, and PGP private key blocks.
 */
export const PRIVATE_KEY_PATTERNS: readonly SecretPattern[] = [
  { name: "private-key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
];

/** Placeholder passwords that show up in docs and examples, not secrets. */
const PLACEHOLDER = /^(?:\$\{[^}]*\}|\$[A-Z_]+|<[^>]*>|\{\{[^}]*\}\}|\*+|x+|\.\.\.|pass(?:word)?|pwd|secret|changeme|example|test|dummy|your[-_]?password)$/i;

/**
 * Applied before every summarizer call (SPEC §Security), on the exact request
 * text. High precision on purpose: a hit means the file is not summarized.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  ...PRIVATE_KEY_PATTERNS,
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "stripe-live-key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { name: "anthropic-api-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "openai-api-key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/, accept: (m) => !m[0].startsWith("sk-ant-") },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    name: "url-with-password",
    re: /\b[a-z][a-z0-9+.-]*:\/\/([^\s:@/'"`]+):([^\s@/'"`]+)@[^\s'"`]+/gi,
    accept: (m) => !PLACEHOLDER.test(m[2] ?? ""),
  },
];

export interface SecretHit {
  pattern: string;
  /** 1-based line of the first accepted match. */
  line: number;
}

/** Scans text for secret patterns; returns one hit per pattern that matched. */
export function scanForSecrets(text: string, patterns: readonly SecretPattern[] = PRIVATE_KEY_PATTERNS): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { name, re, accept } of patterns) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (let m = global.exec(text); m; m = global.exec(text)) {
      if (accept && !accept(m)) continue;
      hits.push({ pattern: name, line: text.slice(0, m.index).split("\n").length });
      break;
    }
  }
  return hits;
}

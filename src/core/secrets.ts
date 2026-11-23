const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "private_key_header", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "github_token", re: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "openai_anthropic_key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "slack_token", re: /\bxox[bporase]-[A-Za-z0-9-]{16,}\b/ },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "bearer_secret", re: /\bAuthorization:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._+/=-]{20,}/i },
];

/**
 * Opus H1 exfiltration defense: refuses to publish any Scout proposal containing
 * private keys, API tokens, or high-entropy credential material.
 */
export function scanForSecrets(text: string): string | null {
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(text)) return p.name;
  }
  return null;
}

/**
 * Error text with credentials taken out: the user:password part of any URL (git puts the whole command line, token URL
 * included, into a failed command's message) and bare GitHub tokens. For text that is logged, stored or shown.
 */
export function redactCredentials(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1***@").replace(/\b(?:gh[posur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "***");
}

/** The field itself when clean; otherwise a notice naming the matched pattern, reported through `onWithheld`. */
export function withholdSecrets(text: string, onWithheld?: (pattern: string) => void): string {
  const hit = scanForSecrets(text);
  if (hit === null) return text;
  onWithheld?.(hit);
  return `_Withheld: possible secret (${hit}) in agent output; see the local transcript._`;
}

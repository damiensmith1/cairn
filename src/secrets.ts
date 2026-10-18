/**
 * Masks credentials in text before it leaves the machine (ask() sends passages to an LLM).
 * Conversations sometimes contain pasted keys and tokens; the local store keeps them as they
 * were, but nothing sent out should.
 */
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private key]"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "[anthropic key]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[api key]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[github token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[github token]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[aws key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[slack token]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[google key]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/g, "$1 [token]"],
  // KEY=value / "token": "value" style assignments of anything that looks secret.
  [/\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY)[A-Z0-9_]*)(\s*[=:]\s*)["']?[^\s"'`]{6,}["']?/gi, "$1$2[redacted]"],
];

export function maskSecrets(text: string): string {
  return PATTERNS.reduce((t, [re, replacement]) => t.replace(re, replacement), text);
}

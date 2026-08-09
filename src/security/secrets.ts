const MASK = '[REDACTED]';
const MIN_SECRET_LENGTH = 6;

/** Env var names whose values should be treated as secrets. */
const SECRET_ENV_KEY_PATTERN =
  /(?:API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|AUTH|CREDENTIAL|BEARER|CONNECTION[_-]?STRING|DSN|DATABASE[_-]?URL)/i;

/** Shape-based fallback for keys not present in the environment. */
const GENERIC_SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /-----BEGIN\s+[A-Z0-9 ]*PRIVATE\s+KEY-----/g,
];

/**
 * Masks sensitive values (API keys, tokens, passwords) in rendered output.
 *
 * Secrets are gathered from environment variables whose names match common
 * secret patterns; extra secrets can be registered explicitly. `mask()` is
 * idempotent and safe to apply repeatedly to full strings.
 */
export class SecretManager {
  private readonly secrets = new Set<string>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) continue;
      if (SECRET_ENV_KEY_PATTERN.test(key)) this.secrets.add(value);
    }
  }

  /** Register an additional literal value to mask (e.g. the active API key). */
  addSecret(value: string): void {
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) {
      this.secrets.add(value);
    }
  }

  /** Replace every occurrence of known secrets in `text` with a redaction tag. */
  mask(text: string): string {
    let out = String(text ?? '');
    for (const secret of this.secrets) {
      if (out.indexOf(secret) === -1) continue;
      out = out.split(secret).join(MASK);
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) out = out.split(encoded).join(MASK);
    }
    for (const re of GENERIC_SECRET_PATTERNS) {
      out = out.replace(re, MASK);
    }
    return out;
  }
}

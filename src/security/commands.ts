import { SecurityError } from './pathguard.js';

/**
 * Destructive / risky command patterns. Each entry is a regex and the reason
 * the command is rejected. Matching is deliberately conservative: legitimate
 * project commands like `rm -rf dist` or `rm -rf ./build` are unaffected.
 */
const BLOCK_PATTERNS: Array<[RegExp, string]> = [
  // Recursive deletes targeting system roots or the current user's home.
  [
    /\brm\s+-(?:[a-z]*r[a-z]*f[a-z]*)\s+(?:~(?:[\s/$]|$)|(?:\/)(?:\*|\s|$)|(?:\/root|\/etc|\/var|\/usr|\/bin|\/sbin|\/boot|\/dev|\/proc|\/sys)\b)/,
    'recursive delete of a system path',
  ],
  // Filesystem formatting.
  [/\bmkfs(?:\.\w+)?\b/, 'filesystem formatting'],
  // Writing to block devices (raw disk access).
  [/\bdd\b[^;\n|]*\bof=\/dev\/(?:sd|hd|vd|nvme|mmcblk|dm-)/, 'writing to a block device'],
  [/>\s*\/dev\/(?:sd|hd|vd|nvme|mmcblk|dm-)/, 'writing to a block device'],
  // Fork bomb.
  [/:\s*\(\s*\)\s*\{/, 'fork bomb'],
  // Dumping the environment (bare `env` / `printenv`).
  [/\bprintenv\b/, 'dumping environment variables'],
  [/(?:^|[;&|]\s*)env\s*$/, 'dumping environment variables'],
  // Reading sensitive system / credential files.
  [/\b(?:cat|less|more|head|tail|sed|awk|grep)\s+[^;|\n]*\/(?:etc\/shadow|etc\/gshadow)\b/, 'reading sensitive system files'],
  [
    /\b(?:cat|less|more|head|tail)\s+[^;|\n]*(?:\.aws\/credentials|\.ssh\/id_rsa|\.ssh\/id_ed25519|\.ssh\/id_ecdsa|\.ssh\/id_dsa|\.git-credentials|\.env(?:\.local)?(?:\.\w+)?)\b/,
    'reading credential files',
  ],
  // Remote content piped straight into a shell.
  [/\b(?:curl|wget|lynx|nc)\s+[^|;\n]*\s*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/, 'piping remote content into a shell'],
  // Privilege escalation.
  [/\bsudo\b/, 'privilege escalation'],
  [/\bsu\b(?:\s+-)?/, 'privilege escalation'],
];

export interface CommandCheckOptions {
  /** Additional roots / contexts that may be cited in an error message. */
  cwd?: string;
}

/**
 * Validate a shell command before execution. Throws a `SecurityError` when the
 * command matches a destructive or secret-leaking pattern.
 */
export function assertCommandSafe(command: string, _opts: CommandCheckOptions = {}): void {
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new SecurityError('Command must be a non-empty string.');
  }
  for (const [pattern, reason] of BLOCK_PATTERNS) {
    if (pattern.test(command)) {
      throw new SecurityError(
        `Command blocked: ${reason}. Refusing to execute: ${command.trim().slice(0, 160)}`,
      );
    }
  }
}

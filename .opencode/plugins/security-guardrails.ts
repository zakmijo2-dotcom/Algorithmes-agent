import { promises as fs } from 'node:fs';
import path from 'node:path';

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/**
 * Destructive / risky command patterns.
 */
const BLOCK_PATTERNS: Array<[RegExp, string]> = [
  // Recursive deletes targeting system roots or user home.
  [
    /\brm\s+-(?:[a-z]*r[a-z]*f[a-z]*)\s+(?:~(?:[\s/$]|$)|(?:\/)(?:\*|\s|$)|(?:\/root|\/etc|\/var|\/usr|\/bin|\/sbin|\/boot|\/dev|\/proc|\/sys)\b)/,
    'recursive delete of a system path',
  ],
  // Filesystem formatting.
  [/\bmkfs(?:\.\w+)?\b/, 'filesystem formatting'],
  // Raw disk access.
  [/\bdd\b[^;\n|]*\bof=\/dev\/(?:sd|hd|vd|nvme|mmcblk|dm-)/, 'writing to a block device'],
  [/>\s*\/dev\/(?:sd|hd|vd|nvme|mmcblk|dm-)/, 'writing to a block device'],
  // Fork bomb.
  [/:\s*\(\s*\)\s*\{/, 'fork bomb'],
  // Dumping environment variables.
  [/\bprintenv\b/, 'dumping environment variables'],
  [/(?:^|[;&|]\s*)env\s*$/, 'dumping environment variables'],
  // Reading sensitive credential files.
  [/\b(?:cat|less|more|head|tail|sed|awk|grep)\s+[^;|\n]*\/(?:etc\/shadow|etc\/gshadow)\b/, 'reading sensitive system files'],
  [
    /\b(?:cat|less|more|head|tail)\s+[^;|\n]*(?:\.aws\/credentials|\.ssh\/id_rsa|\.ssh\/id_ed25519|\.ssh\/id_ecdsa|\.ssh\/id_dsa|\.git-credentials|\.env(?:\.local)?(?:\.\w+)?)\b/,
    'reading credential files',
  ],
  // Remote piping straight to shell.
  [/\b(?:curl|wget|lynx|nc)\s+[^|;\n]*\s*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/, 'piping remote content into a shell'],
  // Privilege escalation.
  [/\bsudo\b/, 'privilege escalation'],
  [/\bsu\b(?:\s+-)?/, 'privilege escalation'],
];

export function assertCommandSafe(command: string): void {
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

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function resolvePathSafe(
  root: string,
  inputPath: string,
  extraRoots: string[] = [],
): Promise<string> {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new SecurityError('Path must be a non-empty string.');
  }
  const roots = [root, ...extraRoots];
  const abs = path.resolve(root, inputPath);

  if (!roots.some((r) => isInside(r, abs))) {
    throw new SecurityError(
      `Path "${inputPath}" resolves outside the permitted sandbox (root: ${root}).`,
    );
  }

  const realRoots: string[] = [];
  for (const r of roots) {
    try {
      realRoots.push(await fs.realpath(r));
    } catch {
      realRoots.push(path.resolve(r));
    }
  }

  let prefix = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const realPrefix = await fs.realpath(prefix);
      const resolved = path.resolve(realPrefix, ...tail);
      if (!realRoots.some((r) => isInside(r, resolved))) {
        throw new SecurityError(
          `Path "${inputPath}" resolves outside the permitted sandbox (symlink target).`,
        );
      }
      return resolved;
    } catch (e) {
      if (e instanceof SecurityError) throw e;
      const parent = path.dirname(prefix);
      if (parent === prefix) {
        throw new SecurityError(
          `Path "${inputPath}" could not be resolved inside the sandbox (root: ${root}).`,
        );
      }
      tail.unshift(path.basename(prefix));
      prefix = parent;
    }
  }
}

/** OpenCode Security Guardrails Plugin */
export default function AlgorithmeSecurityPlugin() {
  return {
    name: 'opencode-algorithme-security',
    hooks: {
      async beforeToolCall(params: { toolCall: { name: string; args: any }; context?: any }) {
        const { toolCall } = params;
        const cwd = process.cwd();

        if (toolCall.name === 'bash' || toolCall.name === 'safe_bash') {
          const cmd = toolCall.args?.command ?? toolCall.args?.cmd;
          if (cmd) {
            assertCommandSafe(cmd);
          }
          if (toolCall.args?.cwd) {
            await resolvePathSafe(cwd, toolCall.args.cwd);
          }
        }

        if (['read', 'write', 'edit', 'file_edit', 'diff_apply', 'view_file'].includes(toolCall.name)) {
          const filePath = toolCall.args?.path ?? toolCall.args?.file ?? toolCall.args?.targetFile;
          if (filePath) {
            await resolvePathSafe(cwd, filePath);
          }
        }
      },
    },
  };
}

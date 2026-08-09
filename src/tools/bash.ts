import { exec } from 'node:child_process';
import path from 'node:path';
import { assertCommandSafe } from '../security/commands.js';
import { resolvePathSafe } from '../security/pathguard.js';
import type { Tool } from './registry.js';

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Pick the shell binary for the current platform.
 * - `PI_SHELL` env override wins.
 * - Termux (Android) keeps bash under `$PREFIX/bin/bash` (e.g. /data/data/com.termux/files/usr).
 * - Otherwise fall back to the login shell, then /bin/bash.
 */
function detectShell(): string {
  if (process.env.PI_SHELL) return process.env.PI_SHELL;
  if (process.env.TERMUX_VERSION || process.env.PREFIX) {
    const prefix = process.env.PREFIX ?? '/data/data/com.termux/files/usr';
    return path.join(prefix, 'bin', 'bash');
  }
  return process.env.SHELL || '/bin/bash';
}

export const bashTool: Tool = {
  definition: {
    name: 'bash',
    description:
      'Execute a shell command in the working directory. Returns combined stdout/stderr. Timeout is 120s. Prefer a single command per call.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to run.',
        },
        cwd: {
          type: 'string',
          description: 'Optional directory to run the command in. Defaults to the agent cwd.',
        },
      },
      required: ['command'],
    },
  },

  async execute(args: { command: string; cwd?: string }, ctx): Promise<string> {
    if (!args.command || typeof args.command !== 'string') {
      throw new Error('bash: "command" must be a non-empty string');
    }

    assertCommandSafe(args.command, { cwd: ctx.cwd });

    const runCwd = args.cwd
      ? await resolvePathSafe(ctx.cwd, args.cwd, {
          extraRoots: (ctx.allowPaths as string[] | undefined) ?? [],
        })
      : ctx.cwd;

    return new Promise<string>((resolve, reject) => {
      exec(
        args.command,
        {
          cwd: runCwd,
          env: process.env,
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          shell: detectShell(),
        },
        (error, stdout, stderr) => {
          const out = [stdout, stderr].filter(Boolean).join('\n').trim();
          if (error) {
            const code = typeof (error as any).code === 'number' ? (error as any).code : 'signal';
            const msg = `Command failed (exit ${code}):\n${out}\n${error.message ?? ''}`;
            reject(new Error(msg.trim()));
            return;
          }
          resolve(out || '(no output)');
        },
      );
    });
  },
};

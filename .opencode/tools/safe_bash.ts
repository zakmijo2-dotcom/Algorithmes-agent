import { exec } from 'node:child_process';
import { assertCommandSafe, resolvePathSafe } from '../plugins/security-guardrails.js';

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export default {
  name: 'safe_bash',
  description:
    'Execute shell commands in the working directory safely under security guardrails.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute.',
      },
      cwd: {
        type: 'string',
        description: 'Optional target working directory.',
      },
    },
    required: ['command'],
  },
  async execute(args: { command: string; cwd?: string }) {
    const defaultCwd = process.cwd();
    assertCommandSafe(args.command);
    const runCwd = args.cwd ? await resolvePathSafe(defaultCwd, args.cwd) : defaultCwd;

    return new Promise<string>((resolve, reject) => {
      exec(
        args.command,
        {
          cwd: runCwd,
          env: process.env,
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          shell: process.env.SHELL || '/bin/bash',
        },
        (error, stdout, stderr) => {
          const out = [stdout, stderr].filter(Boolean).join('\n').trim();
          if (error) {
            reject(new Error(`Command failed:\n${out}\n${error.message}`));
            return;
          }
          resolve(out || '(no output)');
        },
      );
    });
  },
};

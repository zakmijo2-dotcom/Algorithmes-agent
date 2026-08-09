import { exec } from 'node:child_process';
import path from 'node:path';
import type { Tool } from './registry.js';

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

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

    return new Promise<string>((resolve, reject) => {
      exec(
        args.command,
        {
          cwd: args.cwd ? path.resolve(ctx.cwd, args.cwd) : ctx.cwd,
          env: process.env,
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          shell: '/bin/bash',
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

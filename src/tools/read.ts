import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool } from './registry.js';

export const readTool: Tool = {
  definition: {
    name: 'read',
    description:
      'Read a file from the local filesystem. Returns the requested slice of the file with line numbers. Reading a directory returns its sorted entries.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or cwd-relative path to the file or directory.',
        },
        offset: {
          type: 'integer',
          description: '1-indexed line to start reading from. Defaults to 1.',
          minimum: 1,
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of lines to read. Defaults to 2000.',
          minimum: 1,
        },
      },
      required: ['path'],
    },
  },

  async execute(args: { path: string; offset?: number; limit?: number }, ctx) {
    const abs = path.resolve(ctx.cwd, args.path);
    const stat = await fs.stat(abs);

    if (stat.isDirectory()) {
      const entries = await fs.readdir(abs);
      return `Directory ${abs} (${entries.length} entries):\n${entries.sort().join('\n')}`;
    }

    const content = await fs.readFile(abs, 'utf8');
    const lines = content.split('\n');
    const offset = Math.max(1, Math.trunc(args.offset ?? 1));
    const limit = Math.max(1, Math.trunc(args.limit ?? 2000));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const total = lines.length;
    const numbered = slice.map((line, i) => `${offset + i}: ${line}`).join('\n');

    const truncated =
      offset + slice.length - 1 < total ? `\n... (${total - (offset + slice.length - 1)} more lines)` : '';
    return numbered + truncated;
  },
};

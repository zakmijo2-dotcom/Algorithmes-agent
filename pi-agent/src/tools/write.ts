import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool } from './registry.js';

export const writeTool: Tool = {
  definition: {
    name: 'write',
    description:
      'Create a new file or overwrite an existing file with the given content. Parent directories are created automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or cwd-relative path of the file to write.',
        },
        content: {
          type: 'string',
          description: 'Full content to write to the file.',
        },
      },
      required: ['path', 'content'],
    },
  },

  async execute(args: { path: string; content: string }, ctx) {
    const abs = path.resolve(ctx.cwd, args.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, args.content, 'utf8');
    const bytes = Buffer.byteLength(args.content, 'utf8');
    return `Wrote ${bytes} bytes to ${abs}`;
  },
};

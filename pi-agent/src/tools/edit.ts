import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ToolError, type Tool } from './registry.js';

export const editTool: Tool = {
  definition: {
    name: 'edit',
    description:
      'Surgical replacement of an exact string within a file. Fails safely if old_str is missing or matches multiple times, to force unambiguous edits.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or cwd-relative path of the file to edit.',
        },
        old_str: {
          type: 'string',
          description: 'The exact text to replace. Must match exactly once.',
        },
        new_str: {
          type: 'string',
          description: 'The replacement text.',
        },
      },
      required: ['path', 'old_str', 'new_str'],
    },
  },

  async execute(args: { path: string; old_str: string; new_str: string }, ctx) {
    const abs = path.resolve(ctx.cwd, args.path);
    const content = await fs.readFile(abs, 'utf8');
    const matches = content.split(args.old_str).length - 1;

    if (matches === 0) {
      throw new ToolError(`old_str was not found in ${abs}`, 'edit');
    }
    if (matches > 1) {
      throw new ToolError(`old_str matches ${matches} times in ${abs}; provide more context`, 'edit');
    }

    const updated = content.replace(args.old_str, args.new_str);
    await fs.writeFile(abs, updated, 'utf8');
    return `Applied edit to ${abs} (1 replacement).`;
  },
};

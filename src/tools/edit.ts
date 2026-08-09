import { promises as fs } from 'node:fs';
import { resolvePathSafe } from '../security/pathguard.js';
import { ToolError, type Tool } from './registry.js';
import { applyReplacement, generateDiffString, normalizeToLF, stripBom } from '../utils/text.js';

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
        show_diff: {
          type: 'boolean',
          description: 'When true, include a line diff of the change in the result. Defaults to false.',
        },
      },
      required: ['path', 'old_str', 'new_str'],
    },
  },

  async execute(args: { path: string; old_str: string; new_str: string; show_diff?: boolean }, ctx) {
    const abs = await resolvePathSafe(ctx.cwd, args.path, {
      extraRoots: (ctx.allowPaths as string[] | undefined) ?? [],
    });
    const raw = await fs.readFile(abs, 'utf8');
    const { bom, text } = stripBom(raw);
    const oldText = normalizeToLF(args.old_str);
    const newText = normalizeToLF(args.new_str);
    const before = text;

    let updated: string;
    try {
      updated = applyReplacement(before, oldText, newText);
    } catch (e) {
      throw new ToolError((e as Error).message, 'edit');
    }
    if (updated === before) {
      throw new ToolError('No changes made: the replacement produced identical content.', 'edit');
    }

    await fs.writeFile(abs, bom + updated, 'utf8');

    let result = `Applied edit to ${abs} (1 replacement).`;
    if (args.show_diff) {
      const { diff } = generateDiffString(before, updated);
      result += `\n\`\`\`diff\n${diff}\n\`\`\``;
    }
    return result;
  },
};

import { promises as fs } from 'node:fs';
import { resolvePathSafe } from '../security/pathguard.js';
import { ToolError, type Tool } from './registry.js';
import { generateDiffString } from '../utils/text.js';

export const diffTool: Tool = {
  definition: {
    name: 'diff',
    description:
      'Show a line diff between two files, or between the working tree version and HEAD for one file. Useful to inspect changes before committing.',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Absolute or cwd-relative path of the file to diff against HEAD.',
        },
        fileA: {
          type: 'string',
          description: 'First file path (old).',
        },
        fileB: {
          type: 'string',
          description: 'Second file path (new).',
        },
        context: {
          type: 'integer',
          description: 'Number of context lines around each change (default 4).',
        },
      },
      oneOf: [{ required: ['file'] }, { required: ['fileA', 'fileB'] }],
    },
  },

  async execute(args: { file?: string; fileA?: string; fileB?: string; context?: number }, ctx) {
    const context = typeof args.context === 'number' && args.context >= 0 ? args.context : 4;
    const extraRoots = { extraRoots: (ctx.allowPaths as string[] | undefined) ?? [] };

    let oldContent: string;
    let newContent: string;
    let label: string;

    if (args.file) {
      const abs = await resolvePathSafe(ctx.cwd, args.file, extraRoots);
      label = args.file;
      try {
        newContent = await fs.readFile(abs, 'utf8');
      } catch {
        throw new ToolError(`Cannot read file: ${abs}`, 'diff');
      }
      try {
        const { execFileSync } = await import('node:child_process');
        oldContent = execFileSync('git', ['show', `HEAD:${args.file}`], {
          cwd: ctx.cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        oldContent = '';
      }
    } else {
      const a = await resolvePathSafe(ctx.cwd, args.fileA!, extraRoots);
      const b = await resolvePathSafe(ctx.cwd, args.fileB!, extraRoots);
      label = `${args.fileA} → ${args.fileB}`;
      oldContent = await fs.readFile(a, 'utf8').catch(() => '');
      newContent = await fs.readFile(b, 'utf8').catch(() => '');
    }

    const { diff, firstChangedLine } = generateDiffString(oldContent, newContent, context);
    if (diff.length === 0) {
      return `No differences between ${label}.`;
    }
    const header = `Diff for ${label}${firstChangedLine !== undefined ? ` (first change at line ${firstChangedLine})` : ''}:`;
    return `${header}\n${diff}`;
  },
};

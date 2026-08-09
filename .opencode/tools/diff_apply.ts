import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolvePathSafe } from '../plugins/security-guardrails.js';

export default {
  name: 'diff_apply',
  description:
    'Show line diffs between files, or between the working file and git HEAD version to inspect changes before committing.',
  parameters: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'File path to diff against git HEAD.',
      },
      fileA: {
        type: 'string',
        description: 'First file (old).',
      },
      fileB: {
        type: 'string',
        description: 'Second file (new).',
      },
    },
  },
  async execute(args: { file?: string; fileA?: string; fileB?: string }) {
    const cwd = process.cwd();

    if (args.file) {
      const abs = await resolvePathSafe(cwd, args.file);
      const newContent = await fs.readFile(abs, 'utf8');
      let oldContent = '';
      try {
        oldContent = execFileSync('git', ['show', `HEAD:${args.file}`], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        oldContent = '';
      }
      return `=== Diff for ${args.file} against HEAD ===\n${generateSimpleDiff(oldContent, newContent)}`;
    }

    if (args.fileA && args.fileB) {
      const absA = await resolvePathSafe(cwd, args.fileA);
      const absB = await resolvePathSafe(cwd, args.fileB);
      const contentA = await fs.readFile(absA, 'utf8').catch(() => '');
      const contentB = await fs.readFile(absB, 'utf8').catch(() => '');
      return `=== Diff ${args.fileA} -> ${args.fileB} ===\n${generateSimpleDiff(contentA, contentB)}`;
    }

    throw new Error('Provide either "file" or both "fileA" and "fileB".');
  },
};

function generateSimpleDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const max = Math.max(oldLines.length, newLines.length);
  const out: string[] = [];

  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o !== n) {
      if (o !== undefined) out.push(`- L${i + 1}: ${o}`);
      if (n !== undefined) out.push(`+ L${i + 1}: ${n}`);
    }
  }
  return out.length ? out.join('\n') : 'No differences found.';
}

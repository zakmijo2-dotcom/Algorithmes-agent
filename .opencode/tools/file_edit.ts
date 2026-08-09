import { promises as fs } from 'node:fs';
import { resolvePathSafe } from '../plugins/security-guardrails.js';

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function applyReplacement(content: string, oldText: string, newText: string): string {
  if (oldText.length === 0) throw new Error('oldText must not be empty.');
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) {
    throw new Error(
      'Could not find the exact text. The old text must match exactly including all whitespace and newlines.',
    );
  }
  if (occurrences > 1) {
    throw new Error(
      `Found ${occurrences} occurrences of the text. The text must be unique; provide more context.`,
    );
  }
  return content.replace(oldText, newText);
}

export default {
  name: 'file_edit',
  description:
    'Surgical replacement of an exact string within a file. Fails safely if old_str is missing or matches multiple times.',
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
  async execute(args: { path: string; old_str: string; new_str: string }) {
    const cwd = process.cwd();
    const abs = await resolvePathSafe(cwd, args.path);
    const raw = await fs.readFile(abs, 'utf8');
    const oldText = normalizeToLF(args.old_str);
    const newText = normalizeToLF(args.new_str);
    const updated = applyReplacement(raw, oldText, newText);

    await fs.writeFile(abs, updated, 'utf8');
    return `Successfully applied edit to ${args.path}.`;
  },
};

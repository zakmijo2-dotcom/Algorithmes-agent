import { promises as fs } from 'node:fs';
import path from 'node:path';

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface ResolveOptions {
  /** Additional absolute root directories treated as permitted (beyond `root`). */
  extraRoots?: string[];
}

function validateInput(inputPath: string): void {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new SecurityError('Path must be a non-empty string.');
  }
}

/**
 * Resolve `inputPath` against `root` and verify the result stays inside the
 * sandbox. The check is two-layered:
 *
 * 1. Lexical: the resolved absolute path must not escape any permitted root.
 * 2. Symlink-aware: the deepest existing ancestor is `realpath`-resolved so a
 *    symlink that points outside the sandbox is rejected too.
 *
 * Returns the fully resolved absolute path, safe to hand to the filesystem.
 */
export async function resolvePathSafe(
  root: string,
  inputPath: string,
  opts: ResolveOptions = {},
): Promise<string> {
  validateInput(inputPath);
  const roots = [root, ...(opts.extraRoots ?? [])];
  const abs = path.resolve(root, inputPath);

  if (!roots.some((r) => isInside(r, abs))) {
    throw new SecurityError(
      `Path "${inputPath}" resolves outside the permitted sandbox (root: ${root}).`,
    );
  }

  // Real-path roots: the sandbox itself may be reached through a symlink.
  const realRoots: string[] = [];
  for (const r of roots) {
    try {
      realRoots.push(await fs.realpath(r));
    } catch {
      realRoots.push(path.resolve(r));
    }
  }

  // Walk up from `abs` to the deepest existing ancestor, realpath it, then
  // re-append the not-yet-existing tail segments.
  let prefix = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const realPrefix = await fs.realpath(prefix);
      const resolved = path.resolve(realPrefix, ...tail);
      if (!realRoots.some((r) => isInside(r, resolved))) {
        throw new SecurityError(
          `Path "${inputPath}" resolves outside the permitted sandbox (symlink target).`,
        );
      }
      return resolved;
    } catch (e) {
      if (e instanceof SecurityError) throw e;
      const parent = path.dirname(prefix);
      if (parent === prefix) {
        throw new SecurityError(
          `Path "${inputPath}" could not be resolved inside the sandbox (root: ${root}).`,
        );
      }
      tail.unshift(path.basename(prefix));
      prefix = parent;
    }
  }
}

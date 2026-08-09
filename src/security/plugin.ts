import type { BeforeToolCallResult, Plugin } from '../plugins/hooks.js';
import { assertCommandSafe } from './commands.js';
import { resolvePathSafe } from './pathguard.js';

/** Built-in tools that take file paths and must respect the sandbox. */
const FILE_TOOLS = new Set(['read', 'write', 'edit']);

function collectPaths(tool: string, args: any): string[] {
  if (tool === 'diff') {
    return [args?.file, args?.fileA, args?.fileB].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
  }
  if (typeof args?.path === 'string' && args.path.length > 0) return [args.path];
  return [];
}

export interface SecurityPluginOptions {
  /** Sandbox root; every file path is validated against it. */
  cwd: string;
  /** Extra absolute directories the agent is allowed to touch. */
  allowPaths?: string[];
}

/**
 * Built-in guardrail plugin. Runs before every tool call and enforces the
 * sandbox (path traversal) and command injection policies. Tools enforce the
 * same rules internally; this plugin is a defense-in-depth layer that also
 * protects any future tool that forgets to validate.
 */
export function createSecurityPlugin(opts: SecurityPluginOptions): Plugin {
  return {
    name: 'pi-security',
    version: '1.0.0',
    description: 'Built-in guardrails: sandbox path checks and shell command protection.',
    hooks: {
      beforeToolCall: async (ctx): Promise<BeforeToolCallResult | void> => {
        const root = ctx.cwd || opts.cwd;

        if (FILE_TOOLS.has(ctx.toolName) || ctx.toolName === 'diff') {
          for (const p of collectPaths(ctx.toolName, ctx.args)) {
            try {
              await resolvePathSafe(root, p, { extraRoots: opts.allowPaths });
            } catch (e) {
              return { block: true, reason: (e as Error).message };
            }
          }
        }

        if (ctx.toolName === 'bash') {
          try {
            assertCommandSafe(ctx.args?.command ?? '');
            if (typeof ctx.args?.cwd === 'string' && ctx.args.cwd.length > 0) {
              await resolvePathSafe(root, ctx.args.cwd, { extraRoots: opts.allowPaths });
            }
          } catch (e) {
            return { block: true, reason: (e as Error).message };
          }
        }

        return undefined;
      },
    },
  };
}

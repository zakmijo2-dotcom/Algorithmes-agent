import type { BaseProvider } from '../providers/base.js';
import type { Tool, ToolRegistry } from '../tools/registry.js';
import { AgentLoop } from './loop.js';

export interface SubagentOptions {
  /** Build a provider for the sub-agent (optionally a different model). */
  getProvider: (model?: string) => BaseProvider;
  /** Tool registry the sub-agent may use. Typically the shared registry. */
  tools: ToolRegistry;
  /** Maximum nesting depth before delegation is refused. */
  maxDepth?: number;
  /** Default turn budget for sub-agents. */
  maxTurns?: number;
  maxTokens?: number;
  systemPrompt?: string;
  temperature?: number;
}

/**
 * Registers a `subagent` tool that spawns a fresh, nested agent loop.
 * The sub-agent gets its own conversation, runs in the same cwd, and returns
 * its final text answer to the caller. Nesting is bounded by `maxDepth`.
 */
export function createSubagentTool(opts: SubagentOptions): Tool {
  const maxDepth = opts.maxDepth ?? 3;
  const maxTurns = opts.maxTurns ?? 12;

  return {
    definition: {
      name: 'subagent',
      description:
        'Delegate a self-contained task to a sub-agent. The sub-agent starts a fresh conversation, works toward a concrete goal using the same file tools, and returns its final text answer. Use for isolated sub-tasks (research, refactor a module, draft a report) so the main agent stays focused.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The concrete task for the sub-agent, including any context it needs.',
          },
          model: {
            type: 'string',
            description: 'Optional provider:model id for the sub-agent. Defaults to the main agent model.',
          },
          maxTurns: {
            type: 'integer',
            description: `Optional turn budget for the sub-agent (default ${maxTurns}).`,
          },
        },
        required: ['task'],
      },
    },

    async execute(args: { task?: string; model?: string; maxTurns?: number }, ctx) {
      const depth = (ctx.depth as number) ?? 0;
      if (depth >= maxDepth) {
        return `Error: subagent nesting limit (${maxDepth}) reached. Handle the task yourself.`;
      }
      const task = String(args?.task ?? '').trim();
      if (!task) return 'Error: subagent requires a non-empty "task".';

      const provider = opts.getProvider(args?.model);
      const sub = new AgentLoop(provider, opts.tools, {
        systemPrompt: opts.systemPrompt,
        maxTurns: typeof args?.maxTurns === 'number' ? args.maxTurns : maxTurns,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        cwd: ctx.cwd,
        depth: depth + 1,
      });

      const result = await sub.run(task);
      return result.text;
    },
  };
}

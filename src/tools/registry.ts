import type { ToolDefinition } from '../providers/base.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { bashTool } from './bash.js';
import { diffTool } from './diff.js';

export interface ToolContext {
  cwd: string;
  [key: string]: unknown;
}

export type ToolExecutor = (args: any, ctx: ToolContext) => Promise<string> | string;

export interface Tool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}

export class ToolError extends Error {
  constructor(message: string, public readonly tool: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  registerMany(tools: Tool[]): void {
    for (const tool of tools) this.register(tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  async execute(name: string, args: any, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolError(`Unknown tool: ${name}`, name);
    const result = await tool.execute(args, ctx);
    return typeof result === 'string' ? result : JSON.stringify(result);
  }
}

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerMany([readTool, writeTool, editTool, bashTool, diffTool]);
  return registry;
}

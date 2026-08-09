export interface TurnStartContext {
  turn: number;
  messageCount: number;
}

export interface TurnEndContext {
  text: string;
  toolCalls: number;
  turns: number;
}

/** Fired once at the start of an agent run. */
export interface AgentStartContext {
  input: string;
  cwd: string;
  tools: string[];
  turnLimit: number;
}

/** Context passed to `beforeToolCall` hooks, before a tool executes. */
export interface BeforeToolCallContext {
  toolName: string;
  callId: string;
  args: any;
  cwd: string;
  depth: number;
}

/**
 * Result returned from `beforeToolCall`.
 * Returning `{ block: true }` prevents the tool from executing; the loop emits
 * an error tool result instead. `reason` becomes the text of that error.
 * `terminate` hints that the agent should stop after the current tool batch.
 */
export interface BeforeToolCallResult {
  block: boolean;
  reason?: string;
  terminate?: boolean;
}

/** Context passed to `afterToolCall` hooks, after a tool executes. */
export interface AfterToolCallContext {
  toolName: string;
  callId: string;
  args: any;
  result: string;
  isError: boolean;
  cwd: string;
  depth: number;
}

/** Context passed to `onCompaction` hooks after history is compacted. */
export interface CompactionContext {
  summarizedMessages: number;
  tokensBefore: number;
  summary: string;
}

/**
 * Partial override returned from `afterToolCall`.
 * `content` replaces the tool result text; `isError` flips its error flag.
 * Omitted fields keep the original executed result.
 */
export interface AfterToolCallResult {
  content?: string;
  isError?: boolean;
  terminate?: boolean;
}

/**
 * Plugin hook pipeline. Attach zero-or-more hooks per event name.
 * Hooks run in registration order and may be async.
 */
export interface PluginHooks {
  onAgentStart?: (ctx: AgentStartContext) => void | Promise<void>;
  onTurnStart?: (ctx: TurnStartContext) => void | Promise<void>;
  beforeToolCall?: (ctx: BeforeToolCallContext) => BeforeToolCallResult | void | Promise<BeforeToolCallResult | void>;
  afterToolCall?: (ctx: AfterToolCallContext) => AfterToolCallResult | void | Promise<AfterToolCallResult | void>;
  onCompaction?: (ctx: CompactionContext) => void | Promise<void>;
  onTurnEnd?: (ctx: TurnEndContext) => void | Promise<void>;
}

export type HookName = keyof PluginHooks;

/** A plugin: named bundle of hooks + optional setup that runs at load time. */
export interface Plugin {
  name: string;
  version?: string;
  description?: string;
  setup?: (ctx: { workingDirectory: string }) => void | Promise<void>;
  hooks?: PluginHooks;
}

export const HOOK_NAMES: readonly HookName[] = [
  'onAgentStart',
  'onTurnStart',
  'beforeToolCall',
  'afterToolCall',
  'onCompaction',
  'onTurnEnd',
];

/**
 * Fold `beforeToolCall` results across all plugins. The first plugin that
 * blocks wins; remaining hooks are skipped once a block is found.
 */
export function foldBeforeToolCall(results: Array<BeforeToolCallResult | void>): BeforeToolCallResult | undefined {
  for (const result of results) {
    if (result && result.block) return result;
  }
  return undefined;
}

/**
 * Fold `afterToolCall` results across all plugins. Later plugins override
 * earlier ones field-by-field.
 */
export function foldAfterToolCall(results: Array<AfterToolCallResult | void>): AfterToolCallResult | undefined {
  let merged: AfterToolCallResult | undefined;
  for (const result of results) {
    if (!result) continue;
    merged = {
      ...merged,
      ...result,
    };
  }
  return merged;
}

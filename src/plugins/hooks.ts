export interface TurnStartContext {
  turn: number;
  messageCount: number;
}

export interface TurnEndContext {
  text: string;
  toolCalls: number;
  turns: number;
}

/**
 * Plugin hook pipeline. Attach zero-or-more hooks per event name.
 * Hooks run in registration order and may be async.
 */
export interface PluginHooks {
  onTurnStart?: (ctx: TurnStartContext) => void | Promise<void>;
  beforeToolCall?: (toolName: string, args: any) => void | Promise<void>;
  afterToolCall?: (toolName: string, result: string) => void | Promise<void>;
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
  'onTurnStart',
  'beforeToolCall',
  'afterToolCall',
  'onTurnEnd',
];

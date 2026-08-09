import type { BaseProvider, Message, ToolDefinition } from '../providers/base.js';
import { ToolRegistry, type ToolContext } from '../tools/registry.js';
import { AgentContext } from './context.js';
import type { PluginManager } from '../plugins/manager.js';

export interface AgentOptions {
  systemPrompt?: string;
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
  cwd?: string;
  /** Rough token ceiling used for history compaction. */
  contextWindow?: number;
  /**
   * Called with each incremental text delta as it streams.
   * Enable only in interactive UIs that render progress.
   */
  onTextDelta?: (delta: string) => void;
}

export interface AgentRunResult {
  text: string;
  toolCalls: number;
  turns: number;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are pi, a minimalist, deterministic coding agent running in a terminal.
You operate on the local repository with a small set of native tools. Follow these rules:

1. Think before you act. Prefer a few high-value tool calls over many tiny ones.
2. Use read/write/edit for files. Use bash for anything else: builds, tests, git, grep, etc.
3. When a tool call fails, read the error, diagnose, and self-correct rather than giving up.
4. After completing the task, reply with a concise summary of what you changed and why.
5. Be terse. No pleasantries, no preamble, no trailing remarks.`;

export class AgentLoop {
  private readonly context: AgentContext;
  private readonly options: AgentOptions &
    Required<Pick<AgentOptions, 'maxTurns' | 'temperature' | 'maxTokens' | 'cwd'>>;

  constructor(
    private readonly provider: BaseProvider,
    private readonly tools: ToolRegistry,
    options: AgentOptions = {},
  ) {
    const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.context = new AgentContext(systemPrompt, options.contextWindow ?? 48_000);
    this.options = {
      maxTurns: options.maxTurns ?? 24,
      temperature: options.temperature ?? 0.0,
      maxTokens: options.maxTokens ?? 16_000,
      cwd: options.cwd ?? process.cwd(),
    };
  }

  get contextSize(): number {
    return this.context.size;
  }

  clearHistory(): void {
    this.context.clear();
  }

  /**
   * Deterministic agent loop:
   *  user input -> system prompt + tools -> model stream -> execute tool calls ->
   *  append results -> repeat until the model answers without tool calls.
   */
  async run(input: string, plugins?: PluginManager): Promise<AgentRunResult> {
    this.context.append({ role: 'user', content: input });
    let turns = 0;
    let toolCalls = 0;

    for (;;) {
      turns++;
      await plugins?.emitHook('onTurnStart', {
        turn: turns,
        messageCount: this.context.size,
      });

      const messages = this.context.build();
      const tools: ToolDefinition[] = this.tools.definitions();
      const { text, calls } = await this.streamTurn(messages, tools);

      if (calls.length > 0) {
        toolCalls += calls.length;
        this.context.append({
          role: 'assistant',
          content: text || null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        });

        const results = await this.executeCalls(calls, plugins);
        for (const r of results) {
          this.context.append({ role: 'tool', tool_call_id: r.callId, content: r.content });
        }

        if (turns >= this.options.maxTurns) {
          const text2 = `Stopped after ${this.options.maxTurns} turns without a final answer.`;
          await plugins?.emitHook('onTurnEnd', { text: text2, toolCalls, turns });
          this.context.append({ role: 'assistant', content: text2 });
          return { text: text2, toolCalls, turns };
        }
        continue;
      }

      await plugins?.emitHook('onTurnEnd', { text, toolCalls, turns });
      this.context.append({ role: 'assistant', content: text });
      return { text, toolCalls, turns };
    }
  }

  private async streamTurn(
    messages: Message[],
    tools: ToolDefinition[],
  ): Promise<{ text: string; calls: ToolCallRequest[] }> {
    const textParts: string[] = [];
    const calls = new Map<number, ToolCallRequest>();

    for await (const event of this.provider.chat({
      messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
    })) {
      switch (event.type) {
        case 'text':
          textParts.push(event.delta);
          this.options.onTextDelta?.(event.delta);
          break;
        case 'tool': {
          const existing = calls.get(event.index);
          if (!existing) {
            calls.set(event.index, {
              id: event.delta.id ?? `call_${event.index}`,
              name: event.delta.name ?? '',
              arguments: event.delta.arguments ?? '',
            });
          } else {
            if (event.delta.id) existing.id = event.delta.id;
            if (event.delta.name) existing.name += event.delta.name;
            if (event.delta.arguments) existing.arguments += event.delta.arguments;
          }
          break;
        }
        case 'error':
          throw new Error(`Provider error: ${event.message}`);
        default:
          break;
      }
    }

    const collected = [...calls.values()].filter((c) => c.name);
    return { text: textParts.join(''), calls: collected };
  }

  private async executeCalls(
    calls: ToolCallRequest[],
    plugins?: PluginManager,
  ): Promise<Array<{ callId: string; content: string }>> {
    const ctx: ToolContext = { cwd: this.options.cwd };

    // Run tool calls concurrently — the model decides parallelism; we honor it.
    return Promise.all(
      calls.map(async (call): Promise<{ callId: string; content: string }> => {
        let args: any = {};
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch (e) {
          return {
            callId: call.id,
            content: `Error: tool arguments are not valid JSON: ${(e as Error).message}`,
          };
        }

        await plugins?.emitHook('beforeToolCall', call.name, args);
        try {
          const result = await this.tools.execute(call.name, args, ctx);
          await plugins?.emitHook('afterToolCall', call.name, result);
          return { callId: call.id, content: result };
        } catch (e) {
          const trace = e instanceof Error ? e.stack ?? e.message : String(e);
          return { callId: call.id, content: `Error (${call.name}): ${trace}` };
        }
      }),
    );
  }
}

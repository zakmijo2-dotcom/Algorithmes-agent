import type { BaseProvider, Message, ToolDefinition } from '../providers/base.js';
import { ToolRegistry, type ToolContext } from '../tools/registry.js';
import {
  DEFAULT_COMPACTION_SETTINGS,
  SessionTree,
  type CompactionSettings,
} from './session.js';
import type { PluginManager } from '../plugins/manager.js';

export interface AgentOptions {
  systemPrompt?: string;
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
  cwd?: string;
  /** Nesting depth. Sub-agents run with depth+1 so recursion is bounded. */
  depth?: number;
  /** Rough token ceiling used for history compaction. */
  contextWindow?: number;
  /** Compaction thresholds; set `enabled: false` to disable. */
  compaction?: CompactionSettings;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentRunResult {
  text: string;
  toolCalls: number;
  turns: number;
  usage: TokenUsage;
  durationMs: number;
  /** Number of context compactions performed during the run. */
  compactions: number;
}

/** Per-run callbacks for streaming progress into a UI. */
export interface RunCallbacks {
  /** Incremental text delta as the model streams. */
  onTextDelta?: (delta: string) => void;
  /** Fired before a tool executes. */
  onToolStart?: (name: string, args: any) => void;
  /** Fired after a tool executes successfully. */
  onToolEnd?: (name: string, result: string) => void;
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
4. For isolated sub-tasks, delegate with the subagent tool and use its returned summary.
5. After completing the task, reply with a concise summary of what you changed and why.
6. Be terse. No pleasantries, no preamble, no trailing remarks.`;

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Read the conversation between a user and an AI coding agent, then produce a structured summary covering:

## Goal
[What was the user trying to accomplish?]

## Constraints & Preferences
- [Any constraints or preferences mentioned] (or "(none)")

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next]

Be concise. Preserve exact file paths, function names, and error messages.`;

function serializeMessages(messages: Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    const body = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    parts.push(`<message role="${message.role}">\n${body}\n</message>`);
  }
  return parts.join('\n\n');
}

/** Collect a single non-streaming completion from the provider. */
async function completeText(
  provider: BaseProvider,
  messages: Message[],
  maxTokens: number,
): Promise<string> {
  let text = '';
  for await (const event of provider.chat({ messages, maxTokens })) {
    if (event.type === 'text') text += event.delta;
    if (event.type === 'error') throw new Error(`Provider error during summarization: ${event.message}`);
  }
  return text.trim();
}

export class AgentLoop {
  private readonly session: SessionTree;
  private readonly options: AgentOptions &
    Required<Pick<AgentOptions, 'maxTurns' | 'temperature' | 'maxTokens' | 'cwd' | 'depth'>>;
  private readonly compaction: CompactionSettings;

  constructor(
    private readonly provider: BaseProvider,
    private readonly tools: ToolRegistry,
    options: AgentOptions = {},
  ) {
    this.session = new SessionTree(options.contextWindow ?? 48_000);
    this.options = {
      maxTurns: options.maxTurns ?? 24,
      temperature: options.temperature ?? 0.0,
      maxTokens: options.maxTokens ?? 16_000,
      cwd: options.cwd ?? process.cwd(),
      depth: options.depth ?? 0,
    };
    this.compaction = { ...DEFAULT_COMPACTION_SETTINGS, ...options.compaction };
  }

  get contextSize(): number {
    return this.session.size;
  }

  get sessionTree(): SessionTree {
    return this.session;
  }

  clearHistory(): void {
    this.session.clear();
  }

  /**
   * Deterministic agent loop:
   *  user input -> system prompt + tools -> model stream -> execute tool calls ->
   *  append results -> repeat until the model answers without tool calls.
   */
  async run(
    input: string,
    plugins?: PluginManager,
    callbacks: RunCallbacks = {},
  ): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let compactions = 0;

    await plugins?.emitHook('onAgentStart', {
      input,
      cwd: this.options.cwd,
      tools: this.tools.names(),
      turnLimit: this.options.maxTurns,
    });

    this.session.append({ role: 'user', content: input });
    let turns = 0;
    let toolCalls = 0;

    for (;;) {
      turns++;
      await plugins?.emitHook('onTurnStart', {
        turn: turns,
        messageCount: this.session.size,
      });

      if (this.session.needsCompaction(this.compaction)) {
        compactions += await this.compactContext(plugins);
      }

      const messages = this.buildMessages();
      const tools: ToolDefinition[] = this.tools.definitions();
      const { text, calls, inputTokens, outputTokens } = await this.streamTurn(
        messages,
        tools,
        callbacks.onTextDelta,
      );
      usage.inputTokens += inputTokens;
      usage.outputTokens += outputTokens;

      if (calls.length > 0) {
        toolCalls += calls.length;
        this.session.append({
          role: 'assistant',
          content: text || null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        });

        const results = await this.executeCalls(calls, plugins, callbacks);
        for (const r of results) {
          this.session.append({ role: 'tool', tool_call_id: r.callId, content: r.content });
        }

        if (turns >= this.options.maxTurns) {
          const text2 = `Stopped after ${this.options.maxTurns} turns without a final answer.`;
          await plugins?.emitHook('onTurnEnd', { text: text2, toolCalls, turns });
          this.session.append({ role: 'assistant', content: text2 });
          return { text: text2, toolCalls, turns, usage, durationMs: Date.now() - startedAt, compactions };
        }
        continue;
      }

      await plugins?.emitHook('onTurnEnd', { text, toolCalls, turns });
      this.session.append({ role: 'assistant', content: text });
      return { text, toolCalls, turns, usage, durationMs: Date.now() - startedAt, compactions };
    }
  }

  private buildMessages(): Message[] {
    const system: Message = { role: 'system', content: this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT };
    return [system, ...this.session.build()];
  }

  /** Generate a summary via the provider and apply it as a compaction entry. */
  private async compactContext(plugins?: PluginManager): Promise<number> {
    const preparation = this.session.prepareCompaction(this.compaction);
    if (!preparation) return 0;

    const request = preparation.previousSummary
      ? [
          {
            role: 'system' as const,
            content: `${SUMMARIZATION_SYSTEM_PROMPT}\n\nUpdate the existing summary with the new conversation. Keep the same structure.`,
          },
          { role: 'user' as const, content: `Previous summary:\n${preparation.previousSummary}` },
          { role: 'user' as const, content: serializeMessages(preparation.messagesToSummarize) },
        ]
      : [
          { role: 'system' as const, content: SUMMARIZATION_SYSTEM_PROMPT },
          { role: 'user' as const, content: serializeMessages(preparation.messagesToSummarize) },
        ];

    const summary = await completeText(this.provider, request, 2_000);
    this.session.applyCompaction(preparation, summary);
    await plugins?.emitHook('onCompaction', {
      summarizedMessages: preparation.messagesToSummarize.length,
      tokensBefore: preparation.tokensBefore,
      summary,
    });
    return 1;
  }

  private async streamTurn(
    messages: Message[],
    tools: ToolDefinition[],
    onTextDelta?: (delta: string) => void,
  ): Promise<{ text: string; calls: ToolCallRequest[]; inputTokens: number; outputTokens: number }> {
    const textParts: string[] = [];
    const calls = new Map<number, ToolCallRequest>();
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of this.provider.chat({
      messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
    })) {
      switch (event.type) {
        case 'text':
          textParts.push(event.delta);
          onTextDelta?.(event.delta);
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
        case 'usage':
          inputTokens += event.usage.inputTokens;
          outputTokens += event.usage.outputTokens;
          break;
        case 'error':
          throw new Error(`Provider error: ${event.message}`);
        default:
          break;
      }
    }

    const collected = [...calls.values()].filter((c) => c.name);
    return { text: textParts.join(''), calls: collected, inputTokens, outputTokens };
  }

  private async executeCalls(
    calls: ToolCallRequest[],
    plugins?: PluginManager,
    callbacks: RunCallbacks = {},
  ): Promise<Array<{ callId: string; content: string }>> {
    const ctx: ToolContext = { cwd: this.options.cwd, depth: this.options.depth };

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

        const hookCtx = {
          toolName: call.name,
          callId: call.id,
          args,
          cwd: this.options.cwd,
          depth: this.options.depth,
        };

        const blocked = await plugins?.runBeforeToolCall(hookCtx);
        if (blocked) {
          const text = `Error: tool execution blocked${blocked.reason ? `: ${blocked.reason}` : '.'}`;
          callbacks.onToolEnd?.(call.name, text);
          return { callId: call.id, content: text };
        }

        callbacks.onToolStart?.(call.name, args);
        let result: string;
        let isError = false;
        try {
          result = await this.tools.execute(call.name, args, ctx);
        } catch (e) {
          isError = true;
          result = e instanceof Error ? `Error (${call.name}): ${e.message}` : String(e);
        }
        callbacks.onToolEnd?.(call.name, result);

        const override = await plugins?.runAfterToolCall({
          ...hookCtx,
          result,
          isError,
        });
        if (override) {
          if (override.content !== undefined) result = override.content;
          if (override.isError !== undefined) isError = override.isError;
        }

        const finalText = isError && !result.startsWith('Error') ? `Error (${call.name}): ${result}` : result;
        return { callId: call.id, content: finalText };
      }),
    );
  }
}

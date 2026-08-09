import type { Message } from '../providers/base.js';

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Rolling conversation history with lightweight compaction.
 * When the estimated token budget is exceeded, oldest turns are dropped
 * from the front of the history (after the system prompt), preserving the
 * most recent context the model needs to continue working.
 */
export class AgentContext {
  private readonly history: Message[] = [];

  constructor(
    private systemPrompt: string,
    private readonly maxTokens: number = 48_000,
  ) {}

  get size(): number {
    return this.history.length;
  }

  append(message: Message): void {
    this.history.push(message);
  }

  clear(): void {
    this.history.length = 0;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /** Returns the full message array: system prompt + compacted history. */
  build(): Message[] {
    const system: Message = { role: 'system', content: this.systemPrompt };
    if (this.size === 0) return [system];

    const budget = this.maxTokens - estimateTokens(this.systemPrompt);
    let used = 0;
    let start = this.history.length;

    // Walk backwards, greedily keeping as many recent messages as fit.
    for (let i = this.history.length - 1; i >= 0; i--) {
      const msg = this.history[i];
      let cost = estimateTokens(msg.content ?? '');
      for (const tc of msg.tool_calls ?? []) {
        cost += estimateTokens(tc.function.arguments);
      }
      if (used + cost > budget) break;
      used += cost;
      start = i;
    }

    // Never leave a dangling tool result: advance past any leading tool messages
    // so we always start on a user or assistant turn.
    while (start < this.history.length && this.history[start].role === 'tool') start++;

    return [system, ...this.history.slice(start)];
  }
}

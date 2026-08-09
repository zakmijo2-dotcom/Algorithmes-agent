import {
  BaseProvider,
  ChatParams,
  Message,
  ProviderEvent,
  ToolDefinition,
  Usage,
  expandEnvTemplates,
} from './base.js';

/**
 * Anthropic Messages API provider.
 * Speaks the native Anthropic wire format (SSE) with `tool_use`/`tool_result`
 * blocks and partial-JSON argument streaming. Used directly by Anthropic and
 * by the Anthropic-compatible gateways in the catalog (MiniMax, Kimi, etc).
 *
 * Configuration via env: ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL.
 */
export class AnthropicProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly headers?: Record<string, string>;

  constructor(opts: {
    model: string;
    baseUrl: string;
    apiKey?: string;
    headers?: Record<string, string>;
  }) {
    super();
    this.name = 'anthropic';
    this.model = opts.model;
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.headers = opts.headers;
  }

  async *chat(params: ChatParams): AsyncGenerator<ProviderEvent> {
    const { system, messages } = splitSystem(params.messages);
    const url = `${expandEnvTemplates(this.baseUrl).replace(/\/+$/, '')}/v1/messages`;
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: params.maxTokens ?? 16_000,
      stream: true,
      messages: toAnthropicMessages(messages),
    };
    if (system.length > 0) body.system = system.join('\n\n');
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.tools && params.tools.length > 0) body.tools = toAnthropicTools(params.tools);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-api-key': this.apiKey ?? '',
        'anthropic-version': '2023-06-01',
        ...this.headers,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Provider ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    }
    if (!res.body) throw new Error('Provider returned an empty response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: string | undefined;
    let toolBuffer = new Map<number, { id: string; name: string; args: string }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;

          let event: any;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }

          switch (event.type) {
            case 'message_start':
              usage.inputTokens = event.message?.usage?.input_tokens ?? 0;
              break;
            case 'content_block_start':
              if (event.content_block?.type === 'tool_use') {
                toolBuffer.set(event.index, {
                  id: event.content_block.id ?? `toolu_${event.index}`,
                  name: event.content_block.name ?? '',
                  args: '',
                });
                yield {
                  type: 'tool',
                  index: event.index,
                  delta: {
                    id: event.content_block.id ?? `toolu_${event.index}`,
                    name: event.content_block.name ?? '',
                  },
                };
              }
              break;
            case 'content_block_delta': {
              const index = event.index ?? 0;
              if (event.delta?.type === 'text_delta' && event.delta.text) {
                yield { type: 'text', delta: event.delta.text };
              } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                const buf = toolBuffer.get(index) ?? { id: `toolu_${index}`, name: '', args: '' };
                buf.args += event.delta.partial_json;
                toolBuffer.set(index, buf);
                yield { type: 'tool', index, delta: { arguments: event.delta.partial_json } };
              }
              break;
            }
            case 'message_delta':
              finishReason = event.delta?.stop_reason ?? finishReason;
              if (event.usage?.output_tokens) usage.outputTokens += event.usage.output_tokens;
              break;
            case 'message_stop':
              yield { type: 'usage', usage };
              yield { type: 'end', finishReason: finishReason ?? 'stop' };
              return;
            case 'error':
              throw new Error(`Provider error: ${event.error?.message ?? 'unknown'}`);
            case 'ping':
            default:
              break;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'usage', usage };
    yield { type: 'end', finishReason: finishReason ?? 'stop' };
  }
}

function splitSystem(messages: Message[]): { system: string[]; messages: Message[] } {
  const system: string[] = [];
  const rest: Message[] = [];
  for (const m of messages) {
    if (m.role === 'system' && typeof m.content === 'string') {
      system.push(m.content);
    } else {
      rest.push(m);
    }
  }
  return { system, messages: rest };
}

function toAnthropicTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters ?? { type: 'object', properties: {} },
  }));
}

/**
 * Convert our internal OpenAI-shaped history into Anthropic content blocks.
 * - assistant tool_calls -> `tool_use` blocks
 * - trailing tool results -> a single `user` message with `tool_result` blocks
 */
export function toAnthropicMessages(messages: Message[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    if (m.role === 'user') {
      const blocks: Array<Record<string, unknown>> = [];
      if (typeof m.content === 'string' && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content });
      }
      out.push({ role: 'user', content: blocks });
      continue;
    }

    if (m.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = [];
      if (typeof m.content === 'string' && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeJson(tc.function.arguments),
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    if (m.role === 'tool') {
      // Group consecutive tool results into a single user message.
      const blocks: Array<Record<string, unknown>> = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const t = messages[i];
        blocks.push({
          type: 'tool_result',
          tool_use_id: t.tool_call_id ?? '',
          content: t.content ?? '',
        });
        i++;
      }
      // Anthropic requires strictly alternating roles — fold any immediately
      // following user text into the same user message.
      if (i < messages.length && messages[i].role === 'user' && typeof messages[i].content === 'string') {
        const text = messages[i].content;
        if (text) blocks.push({ type: 'text', text });
        i++;
      }
      i--;
      out.push({ role: 'user', content: blocks });
      continue;
    }
  }

  return out;
}

function safeJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

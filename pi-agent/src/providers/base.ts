export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface AssistantToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Message {
  role: Role;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: AssistantToolCall[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatParams {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Streaming events emitted by a provider.
 * `text`  -> incremental content delta.
 * `tool`  -> incremental tool-call fragment (assembled by id across chunks).
 * `usage` -> token accounting (when supported by the upstream).
 * `end`   -> stream finished (carries the finish reason).
 * `error` -> provider-side failure.
 */
export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; index: number; delta: { id?: string; name?: string; arguments?: string } }
  | { type: 'usage'; usage: Usage }
  | { type: 'end'; finishReason?: string | null }
  | { type: 'error'; message: string };

export interface StreamOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  includeUsage?: boolean;
}

export interface StreamRequest extends StreamOptions, ChatParams {
  model: string;
}

/**
 * Single, dependency-free OpenAI-compatible `chat.completions` streaming client.
 * Used by OpenRouter, Groq and Ollama since they all speak this dialect.
 */
export async function* streamChatCompletions(
  opts: StreamRequest,
): AsyncGenerator<ProviderEvent> {
  const {
    baseUrl,
    apiKey,
    headers,
    includeUsage,
    messages,
    tools,
    temperature,
    maxTokens,
    model,
  } = opts;

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature,
  };
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (tools && tools.length > 0) body.tools = tools;
  if (includeUsage) body.stream_options = { include_usage: true };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
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
  let finished = false;

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
        if (payload === '[DONE]') {
          finished = true;
          return;
        }

        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            },
          };
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'text', delta: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const part: { id?: string; name?: string; arguments?: string } = {};
            if (tc.id) part.id = tc.id;
            if (tc.function?.name) part.name = tc.function.name;
            if (tc.function?.arguments) part.arguments = tc.function.arguments;
            yield { type: 'tool', index: tc.index ?? 0, delta: part };
          }
        }
        if (choice.finish_reason) {
          yield { type: 'end', finishReason: choice.finish_reason };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!finished) yield { type: 'end', finishReason: 'stop' };
}

/**
 * Base contract every provider must implement.
 * Subclasses only need to supply configuration + point at `streamChatCompletions`.
 */
export abstract class BaseProvider {
  abstract readonly name: string;
  abstract readonly model: string;
  abstract chat(params: ChatParams): AsyncIterable<ProviderEvent>;
}

/**
 * Shared implementation for OpenAI-compatible endpoints.
 */
export class OpenAICompatibleProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly headers?: Record<string, string>;
  private readonly includeUsage: boolean;

  constructor(opts: {
    name: string;
    model: string;
    baseUrl: string;
    apiKey?: string;
    headers?: Record<string, string>;
    includeUsage?: boolean;
  }) {
    super();
    this.name = opts.name;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.headers = opts.headers;
    this.includeUsage = opts.includeUsage ?? true;
  }

  chat(params: ChatParams): AsyncIterable<ProviderEvent> {
    return streamChatCompletions({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      headers: this.headers,
      includeUsage: this.includeUsage,
      model: this.model,
      messages: params.messages,
      tools: params.tools,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });
  }
}

import {
  BaseProvider,
  ChatParams,
  Message,
  ProviderEvent,
  Usage,
  expandEnvTemplates,
} from './base.js';

/**
 * Google Gemini provider — native `generateContent` SSE streaming.
 * Uses the OpenAI-style history stored by the agent and converts it to Gemini
 * `contents` with `functionCall`/`functionResponse` parts.
 *
 * Configuration via env: GOOGLE_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY,
 * GEMINI_API_KEY, GEMINI_BASE_URL.
 */
export class GeminiProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(opts: { model: string; baseUrl: string; apiKey?: string }) {
    super();
    this.name = 'google';
    this.model = opts.model;
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
  }

  async *chat(params: ChatParams): AsyncGenerator<ProviderEvent> {
    const systemText = params.messages
      .filter((m) => m.role === 'system' && typeof m.content === 'string')
      .map((m) => m.content as string)
      .join('\n\n');

    const url = `${expandEnvTemplates(this.baseUrl).replace(/\/+$/, '')}/models/${this.model}:streamGenerateContent?alt=sse`;
    const body: Record<string, unknown> = {
      contents: toGeminiContents(params.messages),
      generationConfig: {
        temperature: params.temperature,
        maxOutputTokens: params.maxTokens,
      },
    };
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
    if (params.tools && params.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: params.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.apiKey ?? '',
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
    let emittedEnd = false;
    const toolBuffer = new Map<number, { name: string; args: string }>();

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
          if (!payload || payload === '[DONE]') continue;

          let chunk: any;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }

          if (chunk.usageMetadata) {
            usage = {
              inputTokens: chunk.usageMetadata.promptTokenCount ?? usage.inputTokens,
              outputTokens: chunk.usageMetadata.candidatesTokenCount ?? usage.outputTokens,
            };
          }

          const candidate = chunk.candidates?.[0];
          if (!candidate) continue;
          const parts = candidate.content?.parts ?? [];

          for (const part of parts) {
            if (typeof part.text === 'string' && part.text.length > 0) {
              yield { type: 'text', delta: part.text };
            }
            if (part.functionCall) {
              const fc = part.functionCall;
              const name = fc.name ?? '';
              const args = JSON.stringify(fc.args ?? {});
              yield { type: 'tool', index: 0, delta: { id: `call_0`, name, arguments: args } };
              toolBuffer.set(0, { name, args });
            }
          }

          const reason = candidate.finishReason ?? candidate.finish_reason;
          if (reason) {
            yield { type: 'end', finishReason: mapFinishReason(reason) };
            emittedEnd = true;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'usage', usage };
    if (!emittedEnd) yield { type: 'end', finishReason: 'stop' };
  }
}

function mapFinishReason(reason: string): string {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    case 'FUNCTION_CALL':
      return 'tool_use';
    case 'STOP':
    default:
      return 'stop';
  }
}

/**
 * Convert our OpenAI-shaped history into Gemini `contents`.
 * - assistant tool_calls -> `functionCall` parts
 * - tool results -> `functionResponse` parts on a `function` role message
 */
export function toGeminiContents(messages: Message[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    if (m.role === 'user') {
      const parts: Array<Record<string, unknown>> = [];
      if (typeof m.content === 'string' && m.content.length > 0) {
        parts.push({ text: m.content });
      }
      out.push({ role: 'user', parts });
      continue;
    }

    if (m.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      if (typeof m.content === 'string' && m.content.length > 0) {
        parts.push({ text: m.content });
      }
      for (const tc of m.tool_calls ?? []) {
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: safeJson(tc.function.arguments),
          },
        });
      }
      out.push({ role: 'model', parts });
      continue;
    }

    if (m.role === 'tool') {
      // Look backwards for the assistant message that issued this tool call.
      let fnName = '';
      for (let j = i - 1; j >= 0; j--) {
        const prev = messages[j];
        if (prev.role !== 'assistant') continue;
        const tc = prev.tool_calls?.find((c) => c.id === m.tool_call_id);
        if (tc) {
          fnName = tc.function.name;
          break;
        }
        break;
      }
      const parts: Array<Record<string, unknown>> = [];
      parts.push({
        functionResponse: {
          name: fnName || 'unknown_function',
          response: { result: m.content ?? '' },
        },
      });
      out.push({ role: 'function', parts });
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

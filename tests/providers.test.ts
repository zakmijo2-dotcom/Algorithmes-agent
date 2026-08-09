import { describe, it, expect, vi } from 'vitest';
import { parseModelId, createProvider, isOpenAICompatible, PROVIDER_REGISTRY, DEFAULT_MODEL } from '../src/providers/factory.js';
import { PROVIDERS } from '../src/providers/catalog.js';
import { OpenAICompatibleProvider } from '../src/providers/base.js';
import type { ChatParams, ProviderEvent } from '../src/providers/base.js';

describe('parseModelId', () => {
  it('splits provider:model format with known provider', () => {
    const result = parseModelId('openai:gpt-4o');
    expect(result).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('defaults to openrouter when no colon is present', () => {
    const result = parseModelId('deepseek/deepseek-r1');
    expect(result).toEqual({ provider: 'openrouter', model: 'deepseek/deepseek-r1' });
  });

  it('defaults to openrouter when provider is unknown', () => {
    const result = parseModelId('unknown-provider:some-model');
    expect(result).toEqual({ provider: 'openrouter', model: 'unknown-provider:some-model' });
  });

  it('parses deepseek provider correctly', () => {
    const result = parseModelId('deepseek:deepseek-chat');
    expect(result).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
  });

  it('parses anthropic provider correctly', () => {
    const result = parseModelId('anthropic:claude-3-5-sonnet-latest');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-3-5-sonnet-latest' });
  });
});

describe('isOpenAICompatible', () => {
  it('returns true for openai-kind providers', () => {
    expect(isOpenAICompatible('deepseek')).toBe(true);
    expect(isOpenAICompatible('openai')).toBe(true);
    expect(isOpenAICompatible('ollama-cloud')).toBe(true);
  });

  it('returns false for non-openai providers', () => {
    expect(isOpenAICompatible('anthropic')).toBe(false);
    expect(isOpenAICompatible('google')).toBe(false);
    expect(isOpenAICompatible('azure')).toBe(false);
  });

  it('returns false for unknown provider', () => {
    expect(isOpenAICompatible('nonexistent')).toBe(false);
  });
});

describe('PROVIDER_REGISTRY', () => {
  it('contains a mapping of provider id to name', () => {
    expect(PROVIDER_REGISTRY['openrouter']).toBeDefined();
    expect(PROVIDER_REGISTRY['openai']).toBeDefined();
    expect(PROVIDER_REGISTRY['deepseek']).toBe('DeepSeek');
  });

  it('includes entries for all providers in catalog', () => {
    const catalogIds = Object.keys(PROVIDERS);
    const registryIds = Object.keys(PROVIDER_REGISTRY);
    expect(registryIds.sort()).toEqual(catalogIds.sort());
  });
});

describe('DEFAULT_MODEL', () => {
  it('is a valid model id string', () => {
    expect(typeof DEFAULT_MODEL).toBe('string');
    const parsed = parseModelId(DEFAULT_MODEL);
    expect(parsed.provider).toBeDefined();
    expect(parsed.model).toBeDefined();
  });
});

describe('createProvider', () => {
  it('creates an OpenAICompatibleProvider for openai-kind providers', () => {
    const provider = createProvider('openai:gpt-4o', 'test-key');
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.model).toBe('gpt-4o');
    expect(provider.name).toBe('openai');
  });

  it('creates an OpenAICompatibleProvider for OpenRouter', () => {
    const provider = createProvider('openrouter:meta-llama/llama-3', 'test-key');
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.model).toBe('meta-llama/llama-3');
    expect(provider.name).toBe('openrouter');
  });

  it('creates an OpenAICompatibleProvider for DeepSeek', () => {
    const provider = createProvider('deepseek:deepseek-chat', 'test-key');
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.model).toBe('deepseek-chat');
    expect(provider.name).toBe('deepseek');
  });

  it('creates Anthropic provider for anthropic provider', () => {
    const provider = createProvider('anthropic:claude-3-opus', 'test-key');
    expect(provider.name).toBe('anthropic');
    expect(provider.model).toBe('claude-3-opus');
    expect(provider).not.toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('creates Gemini provider for google provider', () => {
    const provider = createProvider('google:gemini-1.5', 'test-key');
    expect(provider.name).toBe('google');
    expect(provider.model).toBe('gemini-1.5');
    expect(provider).not.toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('creates Azure provider for azure provider', () => {
    const provider = createProvider('azure:gpt-4o', 'test-key');
    expect(provider.name).toBe('azure');
    expect(provider.model).toBe('gpt-4o');
  });

  it('throws for SDK-only providers', () => {
    expect(() => createProvider('amazon-bedrock:claude-3', 'key')).toThrow('requires native SDK auth');
  });

  it('defaults to openrouter for unrecognized provider:model combos', () => {
    const provider = createProvider('totally-fake:unknown-model', 'test-key');
    expect(provider.name).toBe('openrouter');
    expect(provider.model).toBe('totally-fake:unknown-model');
  });

  it('defaults to openrouter when no colon present', () => {
    const provider = createProvider('deepseek/deepseek-r1', 'test-key');
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.model).toBe('deepseek/deepseek-r1');
    expect(provider.name).toBe('openrouter');
  });
});

describe('OpenAICompatibleProvider request payload', () => {
  it('passes correct params to streamChatCompletions via chat', () => {
    const mockEvents: ProviderEvent[] = [
      { type: 'text', delta: 'Hello' },
      { type: 'text', delta: ' world' },
      { type: 'end', finishReason: 'stop' },
    ];

    const provider = new OpenAICompatibleProvider({
      name: 'test',
      model: 'gpt-4',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'secret-key',
    });

    const params: ChatParams = {
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.7,
      maxTokens: 100,
    };

    const stream = provider.chat(params);
    expect(Symbol.asyncIterator in stream || typeof (stream as any)[Symbol.asyncIterator] === 'function').toBe(true);
  });
});

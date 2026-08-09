import { BaseProvider, OpenAICompatibleProvider } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { AzureProvider } from './azure.js';
import { PROVIDERS } from './catalog.js';
import { keyStore } from './keys.js';

export const PROVIDER_REGISTRY: Record<string, string> = Object.fromEntries(
  Object.entries(PROVIDERS).map(([id, cfg]) => [id, cfg.name]),
);

/** Providers backed by OpenAI-compatible chat.completions (streaming + tools). */
export function isOpenAICompatible(provider: string): boolean {
  return PROVIDERS[provider]?.kind === 'openai';
}

export function parseModelId(id: string): { provider: string; model: string } {
  const idx = id.indexOf(':');
  if (idx === -1) return { provider: 'openrouter', model: id };
  const candidate = id.slice(0, idx).toLowerCase();
  if (PROVIDERS[candidate]) {
    return { provider: candidate, model: id.slice(idx + 1) };
  }
  return { provider: 'openrouter', model: id };
}

export function createProvider(id: string, apiKey?: string): BaseProvider {
  const { provider, model } = parseModelId(id);
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);

  if (cfg.kind === 'sdk') {
    throw new Error(
      `Provider "${provider}" (${cfg.name}) requires native SDK auth — ${cfg.note ?? 'not OpenAI-compatible'}. ` +
        `Pick another provider from: ${Object.keys(PROVIDER_REGISTRY).slice(0, 30).join(', ')}…`,
    );
  }

  const resolvedKey =
    apiKey ?? keyStore.get(provider) ?? cfg.env.map((v) => process.env[v]).find((v) => v);

  // Allow <PROVIDER>_BASE_URL env override (e.g., OPENAI_BASE_URL, GROQ_BASE_URL)
  const baseUrlEnv = process.env[`${provider.toUpperCase()}_BASE_URL`];
  const baseUrl = baseUrlEnv ?? cfg.baseUrl ?? '';

  switch (cfg.kind) {
    case 'anthropic':
      return new AnthropicProvider({
        model,
        baseUrl: baseUrlEnv ?? cfg.baseUrl ?? 'https://api.anthropic.com',
        apiKey: resolvedKey,
      });
    case 'gemini':
      return new GeminiProvider({
        model,
        baseUrl: baseUrlEnv ?? cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: resolvedKey,
      });
    case 'azure':
      return new AzureProvider({
        model,
        baseUrl: baseUrlEnv ?? cfg.baseUrl ?? '',
        apiKey: resolvedKey,
        envVars: cfg.env,
      });
    case 'openai':
    default:
      return new OpenAICompatibleProvider({
        name: provider,
        model,
        baseUrl,
        apiKey: resolvedKey,
        headers: cfg.headers,
        includeUsage: cfg.includeUsage ?? true,
      });
  }
}

export { BaseProvider };
export { PROVIDERS };
export const DEFAULT_MODEL = 'openrouter:deepseek/deepseek-v4';

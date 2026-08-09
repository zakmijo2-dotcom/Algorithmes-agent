import { BaseProvider } from './base.js';
import { OpenRouterProvider } from './openrouter.js';
import { GroqProvider } from './groq.js';
import { OllamaProvider } from './ollama.js';

export const PROVIDER_REGISTRY: Record<string, string> = {
  openrouter: 'OpenRouter (cloud, 400+ models)',
  groq: 'Groq (cloud, LPU-fast inference)',
  ollama: 'Ollama (local, offline)',
};

export function parseModelId(id: string): { provider: string; model: string } {
  const idx = id.indexOf(':');
  if (idx === -1) return { provider: 'openrouter', model: id };
  const candidate = id.slice(0, idx).toLowerCase();
  if (PROVIDER_REGISTRY[candidate]) {
    return { provider: candidate, model: id.slice(idx + 1) };
  }
  return { provider: 'openrouter', model: id };
}

export function createProvider(id: string, apiKey?: string): BaseProvider {
  const { provider, model } = parseModelId(id);
  switch (provider) {
    case 'openrouter':
      return new OpenRouterProvider(model, apiKey);
    case 'groq':
      return new GroqProvider(model, apiKey);
    case 'ollama':
      return new OllamaProvider(model, apiKey);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export { BaseProvider };
export const DEFAULT_MODEL = 'openrouter:deepseek/deepseek-r1';

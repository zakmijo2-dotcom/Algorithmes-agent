import { OpenAICompatibleProvider } from './base.js';

/**
 * Ollama provider — fully local inference via the OpenAI-compatible endpoint.
 * Configuration via env: OLLAMA_BASE_URL, OLLAMA_API_KEY (optional).
 * `includeUsage` is disabled because older Ollama builds reject stream_options.
 */
export class OllamaProvider extends OpenAICompatibleProvider {
  constructor(model: string, apiKey?: string) {
    super({
      name: 'ollama',
      model,
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
      apiKey: apiKey ?? process.env.OLLAMA_API_KEY,
      includeUsage: false,
    });
  }
}

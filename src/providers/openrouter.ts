import { OpenAICompatibleProvider } from './base.js';

/**
 * OpenRouter provider — a single API key unlocks 400+ models.
 * Configuration via env: OPENROUTER_API_KEY, OPENROUTER_BASE_URL, OPENROUTER_REFERER.
 */
export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(model: string, apiKey?: string) {
    const headers: Record<string, string> = {};
    const referer = process.env.OPENROUTER_REFERER;
    const title = process.env.OPENROUTER_TITLE ?? 'pi-agent';
    if (referer) headers['HTTP-Referer'] = referer;
    if (title) headers['X-Title'] = title;

    super({
      name: 'openrouter',
      model,
      baseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
      apiKey: apiKey ?? process.env.OPENROUTER_API_KEY,
      headers,
      includeUsage: true,
    });
  }
}

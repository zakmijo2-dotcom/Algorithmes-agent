import { OpenAICompatibleProvider } from './base.js';

/**
 * Groq provider — blazing-fast inference on LPU hardware.
 * Configuration via env: GROQ_API_KEY, GROQ_BASE_URL.
 */
export class GroqProvider extends OpenAICompatibleProvider {
  constructor(model: string, apiKey?: string) {
    super({
      name: 'groq',
      model,
      baseUrl: process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
      apiKey: apiKey ?? process.env.GROQ_API_KEY,
      includeUsage: true,
    });
  }
}

import { OpenAICompatibleProvider } from './base.js';

const API_VERSION = process.env.AZURE_API_VERSION ?? '2024-06-01';

/**
 * Azure OpenAI provider — OpenAI-compatible chat completions behind an
 * `api-key` header and an `api-version` query parameter.
 * Resource name comes from AZURE_RESOURCE_NAME (or the explicit baseUrl).
 */
export class AzureProvider extends OpenAICompatibleProvider {
  constructor(opts: {
    model: string;
    baseUrl: string;
    apiKey?: string;
    envVars: string[];
  }) {
    const resource = opts.envVars.map((v) => process.env[v]).find(Boolean);
    const baseUrl =
      opts.baseUrl ??
      (resource ? `https://${resource}.openai.azure.com/openai/v1` : '');

    super({
      name: 'azure',
      model: opts.model,
      baseUrl: baseUrl ? `${baseUrl.replace(/\/+$/, '')}?api-version=${API_VERSION}` : '',
      apiKey: opts.apiKey,
      authHeader: 'api-key',
      includeUsage: true,
    });
  }
}

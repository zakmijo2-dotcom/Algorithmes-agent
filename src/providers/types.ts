export type ProviderKind = 'openai' | 'anthropic' | 'gemini' | 'azure' | 'sdk';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  env: string[];
  headers?: Record<string, string>;
  includeUsage?: boolean;
  note?: string;
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `/key` config manager — persists API keys to a JSON file so providers can be
 * used without exporting environment variables every session.
 *
 * File: ~/.config/algorithme/keys.json (or $XDG_CONFIG_HOME/algorithme/keys.json)
 */
export class KeyStore {
  private readonly file: string;
  private keys: Record<string, string> = {};

  constructor(file?: string) {
    this.file =
      file ??
      path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'algorithme', 'keys.json');
  }

  load(): void {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.keys = JSON.parse(raw) as Record<string, string>;
    } catch {
      this.keys = {};
    }
  }

  get(providerId: string): string | undefined {
    return this.keys[providerId];
  }

  names(): string[] {
    return Object.keys(this.keys);
  }

  set(providerId: string, apiKey: string): void {
    this.keys[providerId] = apiKey.trim();
    this.persist();
  }

  remove(providerId: string): boolean {
    if (!(providerId in this.keys)) return false;
    delete this.keys[providerId];
    this.persist();
    return true;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.keys, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}

export const keyStore = new KeyStore();
keyStore.load();

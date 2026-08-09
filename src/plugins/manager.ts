import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOOK_NAMES, type HookName, type Plugin } from './hooks.js';

const MODULE_EXT = new Set(['.ts', '.js', '.mjs', '.cjs']);

export interface LoadPluginsOptions {
  paths?: string[];
  baseDir?: string;
}

/**
 * Lifecycle manager for plugins: loads them from disk, runs their `setup`,
 * and fans out events to every attached hook.
 */
export class PluginManager {
  private readonly plugins: Plugin[] = [];

  attach(plugin: Plugin): void {
    if (this.plugins.some((p) => p.name === plugin.name)) {
      throw new Error(`Plugin already attached: ${plugin.name}`);
    }
    this.plugins.push(plugin);
  }

  get names(): string[] {
    return this.plugins.map((p) => p.name);
  }

  async loadFromDir(dir: string): Promise<void> {
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      const stat = await fs.stat(full);
      const ext = path.extname(entry);
      if (stat.isDirectory()) {
        await this.loadFromDir(full);
      } else if (MODULE_EXT.has(ext)) {
        await this.loadModuleFile(full);
      }
    }
  }

  async setup(workingDirectory: string): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.setup?.({ workingDirectory });
    }
  }

  async emitHook(name: HookName, ...args: any[]): Promise<void> {
    for (const plugin of this.plugins) {
      const hook = plugin.hooks?.[name];
      if (hook) await (hook as (...a: any[]) => void)(...args);
    }
  }

  private async loadModuleFile(file: string): Promise<void> {
    const mod: any = await import(pathToFileURL(file).href);
    const value = mod.default ?? mod;
    const plugin = this.normalize(value, file);
    this.attach(plugin);
    console.error(`[plugins] loaded "${plugin.name}" from ${file}`);
  }

  private normalize(value: unknown, source: string): Plugin {
    if (!value || typeof value !== 'object' || typeof (value as any).name !== 'string') {
      throw new Error(`Invalid plugin in ${source}: missing "name"`);
    }
    const plugin = value as Plugin;
    for (const hookName of HOOK_NAMES) {
      const hook = plugin.hooks?.[hookName];
      if (hook !== undefined && typeof hook !== 'function') {
        throw new Error(`Plugin "${plugin.name}" hook "${hookName}" is not a function`);
      }
    }
    return plugin;
  }
}

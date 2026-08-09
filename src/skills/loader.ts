import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import type { ToolRegistry } from '../tools/registry.js';
import type { LoadedSkill, Skill } from './types.js';

const DECLARATIVE_EXT = new Set(['.json', '.yaml', '.yml']);
const MODULE_EXT = new Set(['.ts', '.js', '.mjs', '.cjs']);

export interface LoadSkillsOptions {
  /** Extra glob-less list of skill files or directories to load. */
  paths?: string[];
  /** Optional root directory for resolving relative handlerFile paths. */
  baseDir?: string;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function listSkillFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) {
      files.push(...(await listSkillFiles(full)));
    } else if (
      DECLARATIVE_EXT.has(path.extname(entry)) ||
      MODULE_EXT.has(path.extname(entry))
    ) {
      files.push(full);
    }
  }
  return files;
}

function assertSkill(value: unknown, source: string): Skill {
  const s = value as Partial<Skill>;
  if (!s || typeof s !== 'object' || typeof s.name !== 'string' || typeof s.description !== 'string') {
    throw new Error(`Invalid skill in ${source}: missing name or description`);
  }
  if (!s.commands || typeof s.commands !== 'object') {
    throw new Error(`Invalid skill "${s.name}" in ${source}: missing commands map`);
  }
  return { name: s.name, description: s.description, commands: s.commands as Skill['commands'] };
}

async function loadDeclarative(file: string): Promise<Skill> {
  const raw = await fs.readFile(file, 'utf8');
  const parsed = path.extname(file) === '.json' ? JSON.parse(raw) : yaml.load(raw);
  const skill = assertSkill(parsed, file);
  const baseDir = path.dirname(file);

  for (const [name, cmd] of Object.entries(skill.commands)) {
    if (!cmd.handler && cmd.handlerFile) {
      // handlerFile is resolved lazily (dynamic import) so declarative specs stay static-safe.
      const handlerFile = path.resolve(baseDir, cmd.handlerFile);
      cmd.handler = async (args, ctx) => {
        const mod: any = await importModule(handlerFile);
        const candidate = mod?.default ?? mod;
        const fn =
          typeof candidate === 'function'
            ? candidate
            : typeof candidate?.handler === 'function'
              ? candidate.handler
              : typeof mod?.handler === 'function'
                ? mod.handler
                : null;
        if (typeof fn !== 'function') {
          throw new Error(`Skill "${skill.name}.${name}": handlerFile does not export a function`);
        }
        return fn(args, ctx);
      };
    }
    if (typeof cmd.handler !== 'function') {
      throw new Error(
        `Skill "${skill.name}" command "${name}": no handler or handlerFile provided`,
      );
    }
  }
  return skill;
}

async function loadModule(file: string): Promise<Skill> {
  const mod: any = await importModule(file);
  const value = (mod as any).default ?? mod;
  return assertSkill(value, file);
}

async function importModule(file: string): Promise<unknown> {
  return import(pathToFileURL(file).href);
}

function skillToolName(skillName: string, commandName: string): string {
  return `${skillName}_${commandName}`;
}

/**
 * Load skills from a directory (recursively) plus any explicit paths.
 * Every skill command is registered as a tool named `<skill>_<command>`.
 */
export async function loadSkills(
  registry: ToolRegistry,
  options: LoadSkillsOptions = {},
): Promise<LoadedSkill[]> {
  const files = new Set<string>();
  const baseDir = options.baseDir ?? process.cwd();

  for (const entry of options.paths ?? []) {
    const resolved = path.resolve(baseDir, entry);
    if (await isDirectory(resolved)) {
      for (const f of await listSkillFiles(resolved)) files.add(f);
    } else {
      files.add(resolved);
    }
  }

  const skills: LoadedSkill[] = [];

  // Pass 1: declarative specs first — record their handler files so we don't
  // accidentally treat shared handler modules as skills in pass 2.
  const handlerFiles = new Set<string>();
  const ordered = [...files].sort((a, b) => {
    const aDecl = DECLARATIVE_EXT.has(path.extname(a)) ? 0 : 1;
    const bDecl = DECLARATIVE_EXT.has(path.extname(b)) ? 0 : 1;
    return aDecl - bDecl;
  });

  for (const file of ordered) {
    const ext = path.extname(file);
    if (DECLARATIVE_EXT.has(ext)) {
      const skill = await loadDeclarative(file);
      for (const cmd of Object.values(skill.commands)) {
        if (cmd.handlerFile) handlerFiles.add(path.resolve(path.dirname(file), cmd.handlerFile));
      }
      registerSkill(skill, file);
    }
  }

  for (const file of ordered) {
    if (!MODULE_EXT.has(path.extname(file))) continue;
    if (handlerFiles.has(path.resolve(file))) continue;
    try {
      const skill = await loadModule(file);
      registerSkill(skill, file);
    } catch (e) {
      console.error(
        `[skills] skipped ${path.relative(baseDir, file)}: ${(e as Error).message}`,
      );
    }
  }

  function registerSkill(skill: Skill, file: string): void {
    for (const [commandName, cmd] of Object.entries(skill.commands)) {
      const handler = cmd.handler;
      if (typeof handler !== 'function') continue;
      const toolName = skillToolName(skill.name, commandName);
      registry.register({
        definition: {
          name: toolName,
          description: `${skill.description}\nCommand: ${commandName} — ${cmd.description}`,
          parameters:
            cmd.parameters ??
            ({
              type: 'object',
              properties: {},
              additionalProperties: true,
            } as Record<string, unknown>),
        },
        execute: (args, ctx) => handler(args, ctx),
      });
    }

    skills.push({
      ...skill,
      resolveHandler: (commandName) => skill.commands[commandName]?.handler ?? (() => Promise.resolve('no-op')),
    });
    console.error(`[skills] loaded "${skill.name}" from ${path.relative(baseDir, file)}`);
  }

  return skills;
}

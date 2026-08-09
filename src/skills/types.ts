import type { ToolContext } from '../tools/registry.js';

/** Signature every skill command handler must satisfy. */
export type SkillHandler = (args: any, ctx: ToolContext) => string | Promise<string>;

/**
 * A single executable command exposed by a skill.
 * - Inline TS/JS skills define `handler` directly.
 * - Declarative JSON/YAML skills point at `handlerFile` (a module exporting the handler).
 */
export interface SkillCommand {
  description: string;
  parameters?: Record<string, unknown>;
  handler?: SkillHandler;
  handlerFile?: string;
}

/**
 * A domain skill: a named bundle of commands the model can invoke.
 * TS/JS skills export this as the module default; JSON/YAML skills declare it.
 */
export interface Skill {
  name: string;
  description: string;
  commands: Record<string, SkillCommand>;
}

/** Loaded, executable skill after handlers have been resolved. */
export interface LoadedSkill extends Skill {
  resolveHandler: (commandName: string) => SkillHandler;
}

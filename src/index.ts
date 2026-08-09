import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import { program } from 'commander';
import { createProvider, PROVIDER_REGISTRY } from './providers/factory.js';
import { createDefaultRegistry, type ToolRegistry } from './tools/registry.js';
import { AgentLoop, type AgentRunResult } from './agent/loop.js';
import { loadSkills } from './skills/loader.js';
import { PluginManager } from './plugins/manager.js';

export interface AppOptions {
  model: string;
  cwd: string;
  system?: string;
  maxTurns?: number;
  temperature?: number;
  skillsDirs: string[];
  pluginsDirs: string[];
  stream: boolean;
}

export class App {
  readonly registry: ToolRegistry = createDefaultRegistry();
  readonly pluginManager = new PluginManager();
  private agent!: AgentLoop;
  private model: string;

  constructor(private readonly opts: AppOptions) {
    this.model = opts.model;
  }

  get streaming(): boolean {
    return this.opts.stream;
  }

  get modelId(): string {
    return this.model;
  }

  async init(): Promise<void> {
    await loadSkills(this.registry, {
      paths: this.opts.skillsDirs,
      baseDir: this.opts.cwd,
    });

    for (const dir of this.opts.pluginsDirs) {
      await this.pluginManager.loadFromDir(path.resolve(this.opts.cwd, dir));
    }
    await this.pluginManager.setup(this.opts.cwd);

    this.pluginManager.attach({
      name: 'cli-display',
      hooks: {
        beforeToolCall: (toolName, args) =>
          console.error(chalk.dim(`  ⚡ ${toolName}(${truncate(JSON.stringify(args ?? {}), 140)})`)),
        afterToolCall: (toolName, result) =>
          console.error(chalk.dim(`  ✓ ${toolName} → ${truncate(result ?? '', 140)}`)),
      },
    });

    this.rebuildAgent();
  }

  setModel(model: string): void {
    this.model = model;
    this.rebuildAgent();
  }

  clearHistory(): void {
    this.agent.clearHistory();
  }

  run(input: string): Promise<AgentRunResult> {
    return this.agent.run(input, this.pluginManager);
  }

  private rebuildAgent(): void {
    const provider = createProvider(this.model);
    this.agent = new AgentLoop(provider, this.registry, {
      systemPrompt: this.opts.system,
      maxTurns: this.opts.maxTurns,
      temperature: this.opts.temperature,
      cwd: this.opts.cwd,
      onTextDelta: this.opts.stream ? (d) => process.stdout.write(chalk.cyan(d)) : undefined,
    });
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat(value.split(',').filter(Boolean));
}

async function singleShot(app: App, prompt: string): Promise<void> {
  try {
    const result = await app.run(prompt);
    if (app.streaming) {
      process.stdout.write('\n');
    } else {
      console.log(result.text);
    }
    console.error(chalk.dim(`[turns: ${result.turns} · tool calls: ${result.toolCalls}]`));
  } catch (e) {
    console.error(chalk.red(`Error: ${(e as Error).message}`));
    process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(chalk.bold('Commands:'));
  console.log('  /model <id>   switch model (e.g. groq:llama-3.3-70b-versatile, ollama:llama3)');
  console.log('  /clear        reset conversation history');
  console.log('  /status       show model and registered tools');
  console.log('  /exit, /quit  leave the agent');
  console.log('  /help         this help');
}

function printStatus(app: App): void {
  console.log(chalk.bold(`model: ${chalk.cyan(app.modelId)}`));
  console.log(chalk.bold(`tools: ${chalk.cyan(app.registry.names().join(', '))}`));
  const plugins = app.pluginManager.names;
  if (plugins.length) console.log(chalk.bold(`plugins: ${chalk.cyan(plugins.join(', '))}`));
}

async function interactive(app: App): Promise<void> {
  console.log(chalk.bold('pi — Pi-architected coding agent'));
  console.log(chalk.dim(`model: ${app.modelId} · /help for commands · /exit to quit`));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    process.stdout.write('\n');
    process.exit(0);
  });

  for (;;) {
    process.stdout.write(chalk.green('pi> '));
    const line = (await rl.question('').catch(() => '')).trim();
    if (!line) continue;

    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.split(' ');
      const arg = rest.join(' ').trim();
      switch (cmd) {
        case '/exit':
        case '/quit':
          rl.close();
          return;
        case '/clear':
          app.clearHistory();
          console.log(chalk.dim('history cleared'));
          break;
        case '/model':
          if (!arg) {
            console.log(chalk.dim(`current model: ${app.modelId}`));
          } else {
            try {
              app.setModel(arg);
              console.log(chalk.green(`model → ${arg}`));
            } catch (e) {
              console.error(chalk.red(`Error: ${(e as Error).message}`));
            }
          }
          break;
        case '/status':
          printStatus(app);
          break;
        case '/help':
          printHelp();
          break;
        default:
          console.log(chalk.dim(`unknown command: ${cmd} (try /help)`));
      }
      continue;
    }

    try {
      const result = await app.run(line);
      if (app.streaming) {
        process.stdout.write('\n');
      } else {
        console.log(result.text);
      }
      console.error(chalk.dim(`[turns: ${result.turns} · tool calls: ${result.toolCalls}]`));
    } catch (e) {
      console.error(chalk.red(`Error: ${(e as Error).message}`));
    }
  }
}

async function main(): Promise<void> {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };

  program
    .name('pi')
    .version(pkg.version)
    .description('Minimalist Pi-architected CLI AI coding agent')
    .argument('[prompt...]', 'Prompt for single-shot mode; omit for interactive chat')
    .option(
      '-m, --model <id>',
      `Model id like openrouter:deepseek/deepseek-r1 (providers: ${Object.keys(PROVIDER_REGISTRY).join(', ')})`,
      process.env.PI_MODEL ?? 'openrouter:deepseek/deepseek-r1',
    )
    .option('-c, --cwd <dir>', 'Working directory', process.cwd())
    .option('-s, --system <text>', 'Custom system prompt')
    .option('-t, --temperature <n>', 'Sampling temperature (default 0.0)', (v) => Number(v), undefined)
    .option('--max-turns <n>', 'Maximum agent loop turns (default 24)', (v) => Number(v), undefined)
    .option('--skills <paths...>', 'Skill files or directories (comma or space separated)', collect, [])
    .option('--plugins <paths...>', 'Plugin directories (comma or space separated)', collect, [])
    .showHelpAfterError()
    .action(async (promptParts: string[] | undefined, opts) => {
      const cwd = path.resolve(opts.cwd);
      const defaultSkills = path.join(cwd, '.pi', 'skills');
      const defaultPlugins = path.join(cwd, '.pi', 'plugins');

      const app = new App({
        model: opts.model,
        cwd,
        system: opts.system,
        maxTurns: opts.maxTurns,
        temperature: opts.temperature,
        skillsDirs: opts.skills.length > 0 ? opts.skills : [defaultSkills],
        pluginsDirs: opts.plugins.length > 0 ? opts.plugins : [defaultPlugins],
        stream: Boolean(process.stdout.isTTY),
      });

      await app.init();

      const prompt = (promptParts ?? []).join(' ');
      if (prompt.trim()) {
        await singleShot(app, prompt);
      } else if (process.stdin.isTTY) {
        await interactive(app);
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        const piped = Buffer.concat(chunks).toString('utf8').trim();
        if (piped) {
          await singleShot(app, piped);
        } else {
          await interactive(app);
        }
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((e) => {
  console.error(chalk.red(`Fatal: ${(e as Error).message}`));
  process.exit(1);
});

import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import { program } from 'commander';
import { createProvider, PROVIDER_REGISTRY } from './providers/factory.js';
import { createDefaultRegistry, type ToolRegistry } from './tools/registry.js';
import { AgentLoop, type AgentRunResult, type RunCallbacks } from './agent/loop.js';
import { createSubagentTool } from './agent/subagent.js';
import { loadSkills } from './skills/loader.js';
import { PluginManager } from './plugins/manager.js';

export interface AppOptions {
  model: string;
  cwd: string;
  system?: string;
  maxTurns?: number;
  temperature?: number;
  maxDepth?: number;
  skillsDirs: string[];
  pluginsDirs: string[];
  stream: boolean;
}

export class App {
  readonly registry: ToolRegistry = createDefaultRegistry();
  readonly pluginManager = new PluginManager();
  private agent!: AgentLoop;
  private model: string;
  private skillNames: string[] = [];

  constructor(private readonly opts: AppOptions) {
    this.model = opts.model;
  }

  get streaming(): boolean {
    return this.opts.stream;
  }

  get modelId(): string {
    return this.model;
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  get skills(): string[] {
    return this.skillNames;
  }

  get sessionStats(): { messages: number; lanes: number; compactions: number } {
    const tree = this.agent.sessionTree;
    const compactions = tree
      .path()
      .filter((e) => e.kind === 'compaction' && e.summary !== undefined).length;
    return { messages: tree.size, lanes: tree.leaves.length, compactions };
  }

  sessionHistory(): string[] {
    return this.agent.sessionTree.path().map((entry) => {
      const id = entry.id.slice(-4);
      if (entry.kind === 'root') return chalk.dim(`${id}  [root]`);
      if (entry.kind === 'compaction') {
        const label = entry.summary
          ? `[compaction · ${entry.tokensBefore ?? '?'}t] ${truncate(entry.summary, 70)}`
          : `[branch] ${entry.label ?? ''}`.trim();
        return chalk.magenta(`${id}  ${label}`);
      }
      const role = entry.message?.role ?? '?';
      const content = truncate(entry.message?.content ?? '', 70);
      return `${id}  ${chalk.cyan(role.padEnd(9))} ${content}`;
    });
  }

  /** Fork the session tree from the n-th message (1-based) in the current path. */
  forkSession(n: number): string {
    const tree = this.agent.sessionTree;
    const messages = tree.path().filter((e) => e.kind === 'message');
    const target = messages[n - 1];
    if (!target) throw new Error(`no message #${n} in the current path (${messages.length} message(s))`);
    return tree.fork(target.id);
  }

  /** Move the session cursor to the entry whose id ends with `suffix`. */
  selectEntry(suffix: string): void {
    const tree = this.agent.sessionTree;
    const match = tree.leaves.find((id) => id.endsWith(suffix));
    if (!match) {
      throw new Error(`no lane ending in "${suffix}". Use /lanes to list them.`);
    }
    tree.select(match);
  }

  laneList(): string[] {
    const tree = this.agent.sessionTree;
    return tree.leaves.map((id) => {
      const depth = tree.path(id).length - 1;
      const active = id === tree.currentId ? chalk.green('*') : ' ';
      return `${active} ${chalk.cyan(id.slice(-4))}  depth ${depth}`;
    });
  }

  async init(): Promise<void> {
    const loaded = await loadSkills(this.registry, {
      paths: this.opts.skillsDirs,
      baseDir: this.opts.cwd,
    });
    this.skillNames = loaded.map((s) => s.name);

    for (const dir of this.opts.pluginsDirs) {
      await this.pluginManager.loadFromDir(path.resolve(this.opts.cwd, dir));
    }
    await this.pluginManager.setup(this.opts.cwd);

    // Sub-agents share the registry and use the currently selected model by default.
    this.registry.register(
      createSubagentTool({
        getProvider: (model) => createProvider(model ?? this.modelId),
        tools: this.registry,
        systemPrompt: this.opts.system,
        temperature: this.opts.temperature,
        maxDepth: this.opts.maxDepth,
      }),
    );

    this.rebuildAgent();
  }

  setModel(model: string): void {
    this.model = model;
    this.rebuildAgent();
  }

  clearHistory(): void {
    this.agent.clearHistory();
  }

  run(input: string, callbacks: RunCallbacks = {}): Promise<AgentRunResult> {
    return this.agent.run(input, this.pluginManager, callbacks);
  }

  private rebuildAgent(): void {
    this.agent = new AgentLoop(createProvider(this.model), this.registry, {
      systemPrompt: this.opts.system,
      maxTurns: this.opts.maxTurns,
      temperature: this.opts.temperature,
      cwd: this.opts.cwd,
    });
  }
}

// ---------------------------------------------------------------------------
// Terminal UI
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class Renderer {
  private spinner: NodeJS.Timeout | null = null;
  private streaming = false;

  private get animate(): boolean {
    return Boolean(process.stderr.isTTY);
  }

  thinking(label: string): void {
    if (!this.animate) {
      process.stderr.write(chalk.dim(`  ⏳ ${label}\n`));
      return;
    }
    let i = 0;
    this.spinner = setInterval(() => {
      const frame = SPINNER_FRAMES[i++ % SPINNER_FRAMES.length];
      process.stderr.write(`\r  ${chalk.cyan(frame)} ${chalk.dim(label)}`);
    }, 80);
  }

  private clearSpinner(): void {
    if (this.spinner) {
      clearInterval(this.spinner);
      this.spinner = null;
      process.stderr.write('\r' + ' '.repeat(72) + '\r');
    }
  }

  onDelta(delta: string): void {
    if (!this.streaming) {
      this.clearSpinner();
      this.streaming = true;
    }
    process.stdout.write(chalk.cyan(delta));
  }

  onToolStart(name: string, args: string): void {
    this.clearSpinner();
    if (this.streaming) {
      process.stdout.write('\n');
      this.streaming = false;
    }
    process.stderr.write(`  ${chalk.cyan('⚡')} ${chalk.bold(name)}(${chalk.dim(args)})\n`);
  }

  onToolEnd(name: string, result: string): void {
    process.stderr.write(`  ${chalk.green('✓')} ${chalk.dim(name)} → ${chalk.dim(result)}\n`);
  }

  finish(): void {
    this.clearSpinner();
    if (this.streaming) {
      process.stdout.write('\n');
      this.streaming = false;
    }
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function formatArgs(args: any): string {
  return truncate(JSON.stringify(args ?? {}), 140);
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat(value.split(',').filter(Boolean));
}

async function executeTurn(app: App, input: string): Promise<AgentRunResult | undefined> {
  const render = new Renderer();
  render.thinking('thinking');
  try {
    const result = await app.run(input, {
      onTextDelta: (delta) => render.onDelta(delta),
      onToolStart: (name, args) => render.onToolStart(name, formatArgs(args)),
      onToolEnd: (name, resultText) => render.onToolEnd(name, truncate(resultText, 160)),
    });
    render.finish();

    if (!app.streaming) {
      process.stdout.write(`${result.text}\n`);
    }

    const seconds = (result.durationMs / 1000).toFixed(1);
    const tokens = `${formatTokens(result.usage.inputTokens)}→${formatTokens(result.usage.outputTokens)}`;
    const compactions = result.compactions > 0 ? ` · ${result.compactions} compacted` : '';
    process.stderr.write(
      chalk.dim(
        `  ⏱ ${seconds}s · ${result.turns} turn${result.turns === 1 ? '' : 's'} · ` +
          `${result.toolCalls} tool call${result.toolCalls === 1 ? '' : 's'} · tokens ${tokens}${compactions}\n`,
      ),
    );
    return result;
  } catch (e) {
    render.finish();
    process.stderr.write(chalk.red(`  Error: ${(e as Error).message}\n`));
    return undefined;
  }
}

async function singleShot(app: App, prompt: string): Promise<void> {
  const result = await executeTurn(app, prompt);
  if (result === undefined) process.exitCode = 1;
}

function printHelp(): void {
  console.log(chalk.bold('Commands:'));
  console.log('  /model <id>     switch model (e.g. groq:llama-3.3-70b-versatile, ollama:llama3)');
  console.log('  /clear          reset conversation history');
  console.log('  /status         show model, cwd, tools, skills, plugins, session');
  console.log('  /history        show the current conversation path');
  console.log('  /fork <n>       branch off from message #n in the current path');
  console.log('  /lanes          list branch leaves; /go <suffix> to switch to one');
  console.log('  /skills         list loaded skills');
  console.log('  /exit, /quit    leave the agent');
  console.log('  /help           this help');
}

function printStatus(app: App): void {
  console.log(chalk.bold(`model:      ${chalk.cyan(app.modelId)}`));
  console.log(chalk.bold(`cwd:        ${chalk.cyan(app.cwd)}`));
  console.log(chalk.bold(`tools:      ${chalk.cyan(app.registry.names().join(', '))}`));
  console.log(chalk.bold(`skills:     ${chalk.cyan(app.skills.join(', ') || 'none')}`));
  const plugins = app.pluginManager.names;
  if (plugins.length) console.log(chalk.bold(`plugins:    ${chalk.cyan(plugins.join(', '))}`));
  const stats = app.sessionStats;
  console.log(chalk.bold(`session:    ${chalk.cyan(`${stats.messages} messages`)} · ` +
    `${stats.lanes} lane${stats.lanes === 1 ? '' : 's'} · ` +
    `${stats.compactions} compaction${stats.compactions === 1 ? '' : 's'}`));
}

function printSkills(app: App): void {
  if (app.skills.length === 0) {
    console.log(chalk.dim('no skills loaded (look in .pi/skills)'));
    return;
  }
  console.log(chalk.bold(`Loaded skills (${app.skills.length}):`));
  for (const skill of app.skills) console.log(`  - ${chalk.cyan(skill)}`);
}

async function interactive(app: App): Promise<void> {
  console.log(chalk.bold(chalk.cyan('π ') + 'pi-agent — deterministic coding agent'));
  console.log(chalk.dim(`  model: ${app.modelId} · cwd: ${app.cwd} · skills: ${app.skills.length}`));
  console.log(chalk.dim('  /help for commands · /exit to quit'));

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
        case '/skills':
          printSkills(app);
          break;
        case '/history':
          for (const line of app.sessionHistory()) console.log(line);
          break;
        case '/fork': {
          const n = Number(arg);
          if (!Number.isInteger(n) || n < 1) {
            console.log(chalk.dim('usage: /fork <n>  (n = 1-based message index, see /history)'));
            break;
          }
          try {
            const id = app.forkSession(n);
            console.log(chalk.green(`forked from message #${n} → new branch ${chalk.cyan(id.slice(-4))}`));
          } catch (e) {
            console.error(chalk.red(`Error: ${(e as Error).message}`));
          }
          break;
        }
        case '/lanes':
          if (app.laneList().length === 0) console.log(chalk.dim('no lanes'));
          for (const lane of app.laneList()) console.log(lane);
          break;
        case '/go': {
          if (!arg) {
            console.log(chalk.dim('usage: /go <suffix>  (e.g. /go e12a, see /lanes)'));
            break;
          }
          try {
            app.selectEntry(arg.replace(/^e/, ''));
            console.log(chalk.green(`switched to lane ${chalk.cyan(`e${arg.replace(/^e/, '')}`)}`));
          } catch (e) {
            console.error(chalk.red(`Error: ${(e as Error).message}`));
          }
          break;
        }
        case '/help':
          printHelp();
          break;
        default:
          console.log(chalk.dim(`unknown command: ${cmd} (try /help)`));
      }
      continue;
    }

    await executeTurn(app, line);
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
    .option('--max-depth <n>', 'Maximum sub-agent nesting depth (default 3)', (v) => Number(v), undefined)
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
        maxDepth: opts.maxDepth,
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

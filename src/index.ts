#!/usr/bin/env node
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { program } from 'commander';
import prompts from 'prompts';
import { createProvider, PROVIDER_REGISTRY, PROVIDERS } from './providers/factory.js';
import { keyStore } from './providers/keys.js';
import { createDefaultRegistry, type ToolRegistry } from './tools/registry.js';
import { AgentLoop, type AgentRunResult, type CompactionRunResult, type RunCallbacks } from './agent/loop.js';
import { createSubagentTool } from './agent/subagent.js';
import { SessionTree } from './agent/session.js';
import { loadSkills } from './skills/loader.js';
import { PluginManager } from './plugins/manager.js';
import { createSecurityPlugin, SecretManager } from './security/index.js';
import { formatTokens, headerBox, table, truncate } from './ui/format.js';
import { Tui } from './ui/renderer.js';
import { TuiApp } from './ui/tui.js';

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
  private readonly secrets = new SecretManager();
  private agent!: AgentLoop;
  private model: string;
  private skillNames: string[] = [];
  /**
   * The agent's in-memory session tree. Owned here so that conversation state
   * (history, lanes, cursor, forks, compaction summaries) survives agent
   * rebuilds — e.g. switching model/provider via /model. Every AgentLoop is
   * constructed with this shared tree instead of allocating a fresh one.
   */
  private readonly tree = new SessionTree();

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

  get maxTurns(): number | undefined {
    return this.opts.maxTurns;
  }

  get skills(): string[] {
    return this.skillNames;
  }

  get sessionStats(): { messages: number; lanes: number; compactions: number } {
    const tree = this.tree;
    const compactions = tree
      .path()
      .filter((e) => e.kind === 'compaction' && e.summary !== undefined).length;
    return { messages: tree.size, lanes: tree.leaves.length, compactions };
  }

  sessionHistory(): string[] {
    return this.tree.path().map((entry) => {
      const id = entry.id.slice(-4);
      if (entry.kind === 'root') return `${chalk.dim('[root]')}`;
      if (entry.kind === 'compaction') {
        const label = entry.summary
          ? `[compaction · ${formatTokens(entry.tokensBefore ?? 0)}t] ${truncate(entry.summary, 60)}`
          : `[branch] ${entry.label ?? ''}`.trim();
        return `${chalk.magenta(label)}`;
      }
      const role = entry.message?.role ?? '?';
      const content = truncate(entry.message?.content ?? '', 60);
      return `${id}  ${chalk.cyan(role.padEnd(9))} ${content}`;
    });
  }

  /** Fork the session tree from the n-th message (1-based) in the current path. */
  forkSession(n: number): string {
    const tree = this.tree;
    const messages = tree.path().filter((e) => e.kind === 'message');
    const target = messages[n - 1];
    if (!target) throw new Error(`no message #${n} in the current path (${messages.length} message(s))`);
    return tree.fork(target.id);
  }

  /** Move the session cursor to the entry whose id ends with `suffix`. */
  selectEntry(suffix: string): void {
    const tree = this.tree;
    const match = tree.leaves.find((id) => id.endsWith(suffix));
    if (!match) {
      throw new Error(`no lane ending in "${suffix}". Use /lanes to list them.`);
    }
    tree.select(match);
  }

  laneList(): string[] {
    const tree = this.tree;
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

    // Built-in guardrails run first so every tool call is path/command checked.
    this.pluginManager.attach(createSecurityPlugin({ cwd: this.opts.cwd }));

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
    this.tree.clear();
  }

  run(input: string, callbacks: RunCallbacks = {}): Promise<AgentRunResult> {
    return this.agent.run(input, this.pluginManager, callbacks);
  }

  async compact(): Promise<CompactionRunResult> {
    return this.agent.compactContext(this.pluginManager);
  }

  private rebuildAgent(): void {
    this.agent = new AgentLoop(createProvider(this.model), this.registry, {
      systemPrompt: this.opts.system,
      maxTurns: this.opts.maxTurns,
      temperature: this.opts.temperature,
      cwd: this.opts.cwd,
      secrets: this.secrets,
      session: this.tree,
    });
  }
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

const COMMANDS: Array<{ cmd: string; help: string }> = [
  { cmd: '/help', help: 'Show this help' },
  { cmd: '/model <id>', help: 'Switch provider/model' },
  { cmd: '/status', help: 'Show model, cwd, tools, skills, session' },
  { cmd: '/skills', help: 'List loaded skills' },
  { cmd: '/history', help: 'Show the current conversation path' },
  { cmd: '/fork <n>', help: 'Branch off from message #n in the path' },
  { cmd: '/lanes', help: 'List branch leaves' },
  { cmd: '/go <suffix>', help: 'Switch the cursor to a lane' },
  { cmd: '/compact', help: 'Summarize old history now' },
  { cmd: '/clear', help: 'Reset conversation history' },
  { cmd: '/key', help: 'Manage stored API keys (/key <provider> [key])' },
  { cmd: '/exit', help: 'Leave the agent' },
];

function printHelp(): void {
  console.log(
    table({
      headers: ['Command', 'Description'],
      rows: COMMANDS.map((c) => [c.cmd, c.help]),
    }),
  );
}

function printStatus(app: App): void {
  const stats = app.sessionStats;
  const rows: string[][] = [
    ['model', app.modelId],
    ['cwd', app.cwd],
    ['tools', app.registry.names().join(', ')],
    ['skills', app.skills.join(', ') || 'none'],
  ];
  const plugins = app.pluginManager.names;
  if (plugins.length) rows.push(['plugins', plugins.join(', ')]);
  rows.push([
    'session',
    `${stats.messages} messages · ${stats.lanes} lane${stats.lanes === 1 ? '' : 's'} · ` +
      `${stats.compactions} compaction${stats.compactions === 1 ? '' : 's'}`,
  ]);
  console.log(table({ headers: ['Key', 'Value'], rows }));
}

function printSkills(app: App): void {
  if (app.skills.length === 0) {
    console.log(chalk.dim('no skills loaded (look in .algorithme/skills)'));
    return;
  }
  console.log(table({ headers: ['Skill'], rows: app.skills.map((s) => [s]) }));
}

function printHistory(app: App): void {
  const lines = app.sessionHistory();
  if (lines.length === 0) {
    console.log(chalk.dim('no history yet'));
    return;
  }
  console.log(table({ headers: ['Entry'], rows: lines.map((l) => [l]) }));
}

async function compactNow(app: App, tui: Tui): Promise<void> {
  tui.resume();
  tui.beginCompacting();
  try {
    const cr = await app.compact();
    tui.finish();
    if (!cr.performed) {
      console.log(chalk.dim('nothing to compact — history is still short'));
      return;
    }
    console.log(
      chalk.green(`compacted ${cr.summarizedMessages} message(s) · ~${formatTokens(cr.tokensBefore)} tokens before`),
    );
    console.log(chalk.dim(cr.summary));
  } catch (e) {
    tui.finish();
    console.error(chalk.red(`Error: ${(e as Error).message}`));
  }
}

async function handleCommand(app: App, tui: Tui, cmd: string, arg: string): Promise<boolean> {
  switch (cmd) {
    case '/exit':
    case '/quit':
      return true;
    case '/help':
      printHelp();
      break;
    case '/status':
      printStatus(app);
      break;
    case '/skills':
      printSkills(app);
      break;
    case '/history':
      printHistory(app);
      break;
    case '/clear':
      app.clearHistory();
      console.log(chalk.dim('history cleared'));
      break;
    case '/key': {
      const [provider, value] = arg.split(' ').map((s) => s.trim());
      if (!provider) {
        const names = keyStore.names();
        if (names.length === 0) {
          console.log(chalk.dim('no stored keys — usage: /key <provider> <api-key>'));
        } else {
          const rows = names.map((n) => [
            n,
            `${PROVIDERS[n]?.name ?? n}`,
            chalk.dim(maskKey(keyStore.get(n) ?? '')),
          ]);
          console.log(table({ headers: ['Provider', 'Name', 'Key'], rows }));
        }
        break;
      }
      if (!value) {
        const stored = keyStore.get(provider);
        if (stored) {
          console.log(chalk.green(`${provider}: ${maskKey(stored)}`));
        } else {
          const env = PROVIDERS[provider]?.env.filter((v) => process.env[v]).join(' / ');
          console.log(
            env
              ? chalk.dim(`${provider}: from env ${env}`)
              : chalk.dim(`${provider}: no key stored — usage: /key ${provider} <api-key>`),
          );
        }
        break;
      }
      if (value === 'clear') {
        if (keyStore.remove(provider)) console.log(chalk.green(`${provider}: key removed`));
        else console.log(chalk.dim(`${provider}: no stored key`));
        break;
      }
      if (!PROVIDERS[provider]) {
        console.log(chalk.red(`unknown provider: ${provider}`));
        break;
      }
      keyStore.set(provider, value);
      console.log(chalk.green(`${provider}: key saved (${maskKey(value)})`));
      break;
    }
    case '/model': {
      if (!arg) {
        console.log(chalk.dim(`current model: ${app.modelId}`));
      } else {
        try {
          app.setModel(arg);
          tui.setModel(arg);
          console.log(chalk.green(`model → ${arg}`));
        } catch (e) {
          console.error(chalk.red(`Error: ${(e as Error).message}`));
        }
      }
      break;
    }
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
    case '/lanes': {
      const lanes = app.laneList();
      if (lanes.length === 0) console.log(chalk.dim('no lanes'));
      else console.log(lanes.join('\n'));
      break;
    }
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
    case '/compact':
      await compactNow(app, tui);
      break;
    default:
      console.log(chalk.dim(`unknown command: ${cmd} (try /help)`));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Run helpers
// ---------------------------------------------------------------------------

function formatArgs(args: any): string {
  return truncate(JSON.stringify(args ?? {}), 120);
}

async function executeTurn(app: App, tui: Tui, input: string): Promise<AgentRunResult | undefined> {
  tui.resume();
  tui.beginThinking();
  try {
    const result = await app.run(input, {
      onTextDelta: (delta) => tui.onDelta(delta),
      onToolStart: (name, args) => tui.onToolStart(name, formatArgs(args)),
      onToolEnd: (name, resultText, isError) => tui.onToolEnd(name, resultText, isError),
    });
    tui.addUsage(result.usage.inputTokens, result.usage.outputTokens);

    // In non-streaming mode (pipes, non-TTY) the final answer is printed here.
    if (!app.streaming) {
      process.stdout.write(`${result.text}\n`);
    }

    const seconds = (result.durationMs / 1000).toFixed(1);
    const tokens = `${formatTokens(result.usage.inputTokens)}→${formatTokens(result.usage.outputTokens)}`;
    const compactions = result.compactions > 0 ? ` · ${result.compactions} compacted` : '';
    tui.emitLine(
      chalk.dim(
        `⏱ ${seconds}s · ${result.turns} turn${result.turns === 1 ? '' : 's'} · ` +
          `${result.toolCalls} tool call${result.toolCalls === 1 ? '' : 's'} · tokens ${tokens}${compactions}`,
      ),
    );
    return result;
  } catch (e) {
    tui.error(`Error: ${(e as Error).message}`);
    return undefined;
  } finally {
    tui.finish();
  }
}

async function singleShot(app: App, prompt: string, useTui = false): Promise<void> {
  if (!useTui || !process.stdout.isTTY || !process.stderr.isTTY) {
    const tui = new Tui(app.modelId, app.cwd);
    const result = await executeTurn(app, tui, prompt);
    if (result === undefined) process.exitCode = 1;
    return;
  }

  const tui = new TuiApp(app.modelId, app.cwd);
  tui.setMaxTurns(app.maxTurns ?? 24);
  tui.addUserMessage(prompt);
  tui.beginAssistantMessage();

  try {
    const result = await app.run(prompt, {
      onTextDelta: (delta) => tui.onTextDelta(delta),
      onToolStart: (name, args) => tui.onToolStart(name, formatArgs(args)),
      onToolEnd: (name, resultText, isError) => tui.onToolEnd(name, resultText, isError),
    });
    tui.addUsage(result.usage.inputTokens, result.usage.outputTokens);
    tui.setTurn(result.turns);
    tui.flushStreaming();

    if (!app.streaming) {
      process.stdout.write(`${result.text}\n`);
    }
  } catch (e) {
    tui.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    tui.stop();
  }
}

// ---------------------------------------------------------------------------
// Interactive REPL
// ---------------------------------------------------------------------------

async function ask(): Promise<string> {
  const response = await prompts<'value'>({
    type: 'autocomplete',
    name: 'value',
    message: 'Algorithme',
    choices: COMMANDS.map((c) => ({ title: c.cmd, description: c.help })),
    // The raw typed input is always the first suggestion so Enter submits
    // exactly what was typed; command matches are offered as completions.
    suggest: async (input, choices) => {
      const text = String(input ?? '').trim();
      if (!text) return [];
      if (text.startsWith('/')) {
        const [name] = text.split(' ');
        const matches = choices.filter(
          (c) =>
            c.title === name ||
            (c.title.startsWith(name) && text.length <= c.title.length) ||
            (c.description ?? '').toLowerCase().includes(text.toLowerCase()),
        );
        return [{ title: text, value: text }, ...matches];
      }
      return [{ title: `send: ${truncate(text, 40)}`, value: text }];
    },
  }, { onCancel: () => process.exit(0) });
  return typeof response?.value === 'string' ? response.value.trim() : '';
}

async function interactive(app: App, useTui = false): Promise<void> {
  const oldTui = new Tui(app.modelId, app.cwd);
  let newTui: TuiApp | null = null;

  if (useTui && process.stdout.isTTY && process.stderr.isTTY) {
    newTui = new TuiApp(app.modelId, app.cwd);
    newTui.setMaxTurns(app.maxTurns ?? 24);
    newTui.start();
    newTui.setupKeyboard();
  }

  const width = Math.min(process.stdout.columns || 80, 78);
  oldTui.print([
    headerBox(
      'Algorithme AI Agent',
      'Deterministic & Secure Multi-Provider Coding Harness',
      width,
      `${app.modelId} · ${app.cwd} · ${app.skills.length} skill${app.skills.length === 1 ? '' : 's'} · /help`,
    ),
    '',
  ]);

  process.on('SIGINT', () => {
    process.stderr.write('\n');
    process.exit(0);
  });

  for (;;) {
    oldTui.resume();
    const line = await ask();
    if (!line) continue;

    if (line.startsWith('/')) {
      oldTui.finish();
      const [cmd, ...rest] = line.split(' ');
      const arg = rest.join(' ').trim();
      const quit = await handleCommand(app, oldTui, cmd, arg);
      if (newTui) {
        newTui.setModel(app.modelId);
        newTui.render();
      }
      if (quit) {
        newTui?.stop();
        return;
      }
      continue;
    }

    if (newTui) {
      newTui.addUserMessage(line);
      newTui.beginAssistantMessage();
      try {
        const result = await app.run(line, {
          onTextDelta: (delta) => newTui!.onTextDelta(delta),
          onToolStart: (name, args) => newTui!.onToolStart(name, formatArgs(args)),
          onToolEnd: (name, resultText, isError) => newTui!.onToolEnd(name, resultText, isError),
        });
        newTui.addUsage(result.usage.inputTokens, result.usage.outputTokens);
        newTui.setTurn(result.turns);
        newTui.flushStreaming();

        if (!app.streaming) {
          process.stdout.write(`${result.text}\n`);
        }
      } catch (e) {
        newTui.error(`Error: ${(e as Error).message}`);
      }
    } else {
      await executeTurn(app, oldTui, line);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };

  program
    .name('algorithme')
    .alias('alg')
    .version(pkg.version)
    .description('Algorithme AI Agent - Deterministic & Secure Multi-Provider Coding Harness')
    .argument('[prompt...]', 'Prompt for single-shot mode; omit for interactive chat')
    .option(
      '-m, --model <id>',
      `Model id like openrouter:deepseek/deepseek-v4 (providers: ${Object.keys(PROVIDER_REGISTRY).join(', ')})`,
      process.env.ALGORITHME_MODEL ?? process.env.PI_MODEL ?? 'openrouter:deepseek/deepseek-v4',
    )
    .option('--no-tui', 'Disable the modern TUI and use simple console output')
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
      const useTui = !opts.noTui;
      const defaultSkills = path.join(cwd, '.algorithme', 'skills');
      const defaultPlugins = path.join(cwd, '.algorithme', 'plugins');

      const app = new App({
        model: opts.model,
        cwd,
        system: opts.system,
        maxTurns: opts.maxTurns,
        temperature: opts.temperature,
        maxDepth: opts.maxDepth,
        skillsDirs: opts.skills.length > 0 ? opts.skills : [defaultSkills],
        pluginsDirs: opts.plugins.length > 0 ? opts.plugins : [defaultPlugins],
        stream: Boolean(process.stdout.isTTY && useTui),
      });

      await app.init();

      const prompt = (promptParts ?? []).join(' ');
      if (prompt.trim()) {
        await singleShot(app, prompt, useTui);
      } else if (process.stdin.isTTY) {
        await interactive(app, useTui);
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

function collect(value: string, previous: string[]): string[] {
  return previous.concat(value.split(',').filter(Boolean));
}

function maskKey(key: string): string {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

main().catch((e) => {
  console.error(chalk.red(`Fatal: ${(e as Error).message}`));
  process.exit(1);
});

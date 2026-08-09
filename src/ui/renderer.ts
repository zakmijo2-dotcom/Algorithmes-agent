import { formatTokens, joinLeftRight, truncate, THEME } from './format.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const SPIN = 80;
const SAVE = '\u001b7';
const RESTORE = '\u001b8';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const CLEAR_LINE = '\u001b[2K';

interface UsageCounters {
  input: number;
  output: number;
}

/**
 * Lightweight TUI for the CLI.
 *
 * Stream separation:
 * - Responses (model text) go to **stdout**.
 * - All status UI (header, footer, spinners, tool boxes, metrics) goes to **stderr**.
 *
 * The footer is a single sticky status line that is rewritten in place. Before
 * streaming model text to stdout the footer is cleared; after streaming ends a
 * newline is emitted so the footer re-renders on a fresh line. Everything
 * degrades to plain newline text when stderr is not a TTY (pipelines, logs).
 */
export class Tui {
  private readonly enabled: boolean;
  private spinner: NodeJS.Timeout | null = null;
  private frame = 0;
  private statusText = '';
  private streaming = false;
  private toolStartTimes = new Map<string, number>();

  constructor(
    private model: string,
    private cwd: string,
    private usage: UsageCounters = { input: 0, output: 0 },
  ) {
    this.enabled = Boolean(process.stderr.isTTY);
    if (this.enabled) this.write(HIDE_CURSOR);
  }

  private get cols(): number {
    return process.stdout.columns || 80;
  }

  private write(text: string): void {
    process.stderr.write(text);
  }

  // -------------------------------------------------------------------------
  // Context updates
  // -------------------------------------------------------------------------

  setModel(model: string): void {
    this.model = model;
    this.renderFooter();
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
    this.renderFooter();
  }

  addUsage(input: number, output: number): void {
    this.usage.input += input;
    this.usage.output += output;
    this.renderFooter();
  }

  // -------------------------------------------------------------------------
  // Footer / status line
  // -------------------------------------------------------------------------

  private buildFooter(): string {
    const modelParts = this.model.split(':');
    const provider = modelParts[0] ? THEME.primary(`[${modelParts[0]}]`) : '';
    const modelName = modelParts[1] ?? this.model;
    const left = `${THEME.accent('◈')} ${THEME.bold(modelName)} ${THEME.secondary(provider)} ${THEME.secondary('·')} ${THEME.secondary(truncate(this.cwd, 36))}`;
    const tokens = `${THEME.secondary('in')} ${THEME.accent(formatTokens(this.usage.input))} ${THEME.secondary('→')} ${THEME.secondary('out')} ${THEME.accent(formatTokens(this.usage.output))}`;
    const status = this.statusText
      ? `  ${THEME.secondary(SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length])} ${THEME.warning(this.statusText)}`
      : '';
    const right = `${tokens}${status}`;
    return joinLeftRight(left, right, this.cols - 1);
  }

  private renderFooter(): void {
    if (!this.enabled) return;
    const line = this.buildFooter();
    // Trailing spaces clear any characters left over from a longer footer.
    this.write(`\r${line}${' '.repeat(Math.max(0, this.cols - 1 - line.length))}`);
  }

  private clearLine(): void {
    if (!this.enabled) return;
    this.write(`\r${CLEAR_LINE}`);
  }

  private startSpinner(label: string): void {
    this.statusText = label;
    this.frame = 0;
    if (!this.enabled) {
      this.emitLine(THEME.secondary(`  ⏳ ${label}…`));
      return;
    }
    if (!this.spinner) {
      this.spinner = setInterval(() => {
        this.frame++;
        this.renderFooter();
      }, SPIN);
    }
    this.renderFooter();
  }

  private stopSpinner(): void {
    if (this.spinner) {
      clearInterval(this.spinner);
      this.spinner = null;
    }
    this.statusText = '';
  }

  // -------------------------------------------------------------------------
  // Phase transitions
  // -------------------------------------------------------------------------

  /** Show the "thinking / reasoning" indicator before a turn's first token. */
  beginThinking(): void {
    this.startSpinner('Thinking');
  }

  /** Show a "compacting context" indicator. */
  beginCompacting(): void {
    this.startSpinner('Compacting');
  }

  /** End a stdout text stream: push the cursor to a fresh line. */
  private endStreaming(): void {
    if (this.streaming) {
      process.stdout.write('\n');
      this.streaming = false;
    }
  }

  /** Stream an incremental text delta to stdout, clearing the footer first. */
  onDelta(delta: string): void {
    if (!this.streaming) {
      this.stopSpinner();
      this.clearLine();
      this.streaming = true;
    }
    process.stdout.write(delta);
  }

  /** A tool call started executing. */
  onToolStart(name: string, args: string): void {
    this.stopSpinner();
    this.endStreaming();
    this.toolStartTimes.set(name, Date.now());
    this.emitLine(`  ${THEME.accent('⚡')} ${THEME.bold(name)}(${THEME.secondary(args)})`);
    this.startSpinner(name);
  }

  /** A tool call finished. `isError` marks failed executions. */
  onToolEnd(name: string, result: string, isError = false): void {
    this.stopSpinner();
    const started = this.toolStartTimes.get(name);
    const took = started !== undefined ? ` ${THEME.secondary(`(${((Date.now() - started) / 1000).toFixed(1)}s)`)}` : '';
    this.toolStartTimes.delete(name);
    const icon = isError ? THEME.error('✗') : THEME.success('✓');
    const line = `  ${icon} ${THEME.bold(name)} ${THEME.secondary('→')} ${isError ? THEME.error(truncate(result, 140)) : THEME.secondary(truncate(result, 140))}${took}`;
    this.emitLine(line);
  }

  /** Emit a committed UI line (footer preserved below it). */
  emitLine(text: string): void {
    if (!this.enabled) {
      this.write(`${text}\n`);
      return;
    }
    this.clearLine();
    this.write(`${text}\n`);
    this.renderFooter();
  }

  /** Write static lines to stderr without footer handling (startup banner). */
  print(lines: string[]): void {
    this.write(`${lines.join('\n')}\n`);
  }

  error(text: string): void {
    this.emitLine(THEME.error(`  ${text}`));
  }

  /** Stop all activity; restore the cursor for the next prompt. */
  finish(): void {
    this.stopSpinner();
    this.endStreaming();
    this.clearLine();
    if (this.enabled) this.write(SHOW_CURSOR);
  }

  /** Hide cursor again after a prompt (pairs with `finish()`). */
  resume(): void {
    if (this.enabled) this.write(HIDE_CURSOR);
  }

  // -------------------------------------------------------------------------
  // Low-level helpers for the header / panels
  // -------------------------------------------------------------------------

  static saveCursor(): string {
    return SAVE;
  }

  static restoreCursor(): string {
    return RESTORE;
  }
}

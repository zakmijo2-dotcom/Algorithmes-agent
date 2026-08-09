import { formatTokens, THEME } from './format.js';

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const CLEAR_LINE = '\u001b[2K';
const ENTER_ALT_SCREEN = '\u001b[?1049h';
const EXIT_ALT_SCREEN = '\u001b[?1049l';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPIN_MS = 80;

export type TuiStatus = 'idle' | 'thinking' | 'running-tool' | 'compacting';

export interface TuiCallbacks {
  onTextDelta: (delta: string) => void;
  onToolStart: (name: string, args: string) => void;
  onToolEnd: (name: string, result: string, isError?: boolean) => void;
  onStatusChange: (status: TuiStatus) => void;
}

interface ChatLine {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp: number;
}

interface ToolSpan {
  name: string;
  args: string;
  result: string;
  isError: boolean;
  durationMs: number;
}

/**
 * A modern, lightweight Terminal User Interface for Algorithme AI Agent.
 *
 * Layout (top to bottom):
 *  ┌─ Header: "Algorithme AI Agent" · model · cwd
 *  │
 *  │  [user]      Hello, what can you do?
 *  │  [assistant] I'm an autonomous coding agent...
 *  │  ⚡ read(file="src/index.ts")
 *  │  ✓ read → 42 lines (1.2s)
 *  │
 *  └─ Status bar: turn · tokens · status (sticky)
 *
 * Uses raw ANSI escape codes — zero external dependencies, works in
 * standard terminals and Termux. Falls back to plain stdout/stderr when
 * not attached to a TTY.
 *
 * The TUI accepts callbacks that bridge into the AgentLoop via RunCallbacks.
 */
export class TuiApp {
  private readonly enabled: boolean;
  private spinner: NodeJS.Timeout | null = null;
  private frame = 0;
  private status: TuiStatus = 'idle';

  private chatLines: ChatLine[] = [];
  private toolSpans = new Map<string, ToolSpan>();
  private toolStartOrder: string[] = [];

  private usage = { input: 0, output: 0 };
  private currentTurn = 0;
  private maxTurns = 24;

  private streaming = false;
  private streamingBuffer = '';
  private streamingRole: 'user' | 'assistant' | undefined;

  constructor(
    private model: string,
    private cwd: string,
  ) {
     this.enabled = Boolean(process.stderr.isTTY && process.stdout.isTTY);
    if (this.enabled) {
      process.stderr.write(ENTER_ALT_SCREEN);
      process.stderr.write(HIDE_CURSOR);
    }
  }

  get callbacks(): TuiCallbacks {
    return {
      onTextDelta: (delta: string) => this.onTextDelta(delta),
      onToolStart: (name: string, args: string) => this.onToolStart(name, args),
      onToolEnd: (name: string, result: string, isError?: boolean) =>
        this.onToolEnd(name, result, isError),
      onStatusChange: (status: TuiStatus) => this.setStatus(status),
    };
  }

  // -------------------------------------------------------------------------
  // Configuration / context updates
  // -------------------------------------------------------------------------

  setModel(model: string): void {
    this.model = model;
    this.render();
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
    this.render();
  }

  addUsage(input: number, output: number): void {
    this.usage.input += input;
    this.usage.output += output;
  }

  setStatus(status: TuiStatus): void {
    this.status = status;
    this.frame = 0;
    if (status !== 'idle' && !this.spinner) {
      this.spinner = setInterval(() => {
        this.frame++;
        this.renderFooter();
      }, SPIN_MS);
    } else if (status === 'idle' && this.spinner) {
      clearInterval(this.spinner);
      this.spinner = null;
    }
    this.renderFooter();
  }

  // -------------------------------------------------------------------------
  // Content methods
  // -------------------------------------------------------------------------

  /** Append a user message to the chat area. */
  addUserMessage(content: string): void {
    this.flushStreaming();
    this.chatLines.push({ role: 'user', content, timestamp: Date.now() });
    this.render();
  }

  /** Start streaming an assistant response. */
  beginAssistantMessage(): void {
    this.flushStreaming();
    this.streaming = true;
    this.streamingBuffer = '';
    this.streamingRole = 'assistant';
  }

  /** Append a tool result message. */
  addToolResult(_callId: string, content: string): void {
    this.flushStreaming();
    this.chatLines.push({ role: 'tool', content, timestamp: Date.now() });
    this.render();
  }

  /** Flush any buffered streaming text into a committed chat line. */
  flushStreaming(): void {
    if (this.streaming && this.streamingRole) {
      this.chatLines.push({
        role: this.streamingRole,
        content: this.streamingBuffer,
        timestamp: Date.now(),
      });
      this.streaming = false;
      this.streamingBuffer = '';
      this.streamingRole = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Callback handlers (bridge from AgentLoop)
  // -------------------------------------------------------------------------

  onTextDelta(delta: string): void {
    this.streamingBuffer += delta;
    this.renderContent();
  }

  onToolStart(name: string, args: string): void {
    this.flushStreaming();
    const id = `${name}-${Date.now()}`;
    this.toolSpans.set(id, {
      name,
      args,
      result: '',
      isError: false,
      durationMs: 0,
    });
    this.toolStartOrder.push(id);
  }

  onToolEnd(name: string, result: string, isError = false): void {
    const latestKey = this.toolStartOrder[this.toolStartOrder.length - 1];
    if (latestKey) {
      const existing = this.toolSpans.get(latestKey);
      if (existing && existing.name === name) {
        existing.result = result;
        existing.isError = isError;
        existing.durationMs = Date.now() - existing.durationMs;
        this.chatLines.push({
          role: 'tool',
          content: this.formatToolResult(existing),
          timestamp: Date.now(),
        });
        this.toolSpans.delete(latestKey);
        this.toolStartOrder.pop();
      }
    }
    this.render();
  }

  setMaxTurns(max: number): void {
    this.maxTurns = max;
  }

  setTurn(turn: number): void {
    this.currentTurn = turn;
    this.renderFooter();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private get cols(): number {
    return process.stdout.columns || 80;
  }

  private get rows(): number {
    return process.stderr.rows || 24;
  }

  /** Re-render the entire screen (public for external triggers). */
  render(): void {
    if (!this.enabled) return;
    this.clearScreen();
    this.renderHeader();
    this.renderContent();
    this.renderFooter();
  }

  private clearScreen(): void {
    process.stderr.write('\x1b[2J\x1b[H');
  }

  private renderHeader(): void {
    const width = this.cols;
    const bar = '━'.repeat(Math.max(1, width - 4));
    const modelParts = this.model.split(':');
    const providerName = modelParts[0] || '';
    const modelName = modelParts[1] ?? this.model;

    const title = `${THEME.accent('Algorithme AI Agent')}`;
    const subtitle = `${THEME.secondary(providerName)} ${THEME.secondary('·')} ${THEME.bold(modelName)}`;
    const meta = `${THEME.secondary(this.cwd)}`;

    const lines = [
      `${THEME.primary('┏━')}${THEME.secondary(bar)}${THEME.secondary('━┓')}`,
      `┃ ${this.pad(title, width - 4)} ┃`,
      `┃ ${this.pad(subtitle, width - 4)} ┃`,
      `┃ ${this.pad(meta, width - 4)} ┃`,
      `${THEME.primary('┗━')}${THEME.secondary(bar)}${THEME.secondary('━┛')}`,
      '',
    ];
    process.stderr.write(lines.join('\n') + '\n');
  }

  private renderContent(): void {
    if (!this.enabled) return;
    const chatHeight = this.rows - 10;
    let startIdx = 0;
    let linesUsed = 0;
    for (let i = this.chatLines.length - 1; i >= 0; i--) {
      const line = this.chatLines[i];
      const contentLines = this.wrapText(this.stripAnsi(line.content), this.cols - 6).length;
      if (line.role === 'tool') {
        linesUsed += contentLines + 1;
      } else {
        linesUsed += contentLines + 1;
      }
      if (linesUsed >= chatHeight) {
        startIdx = i;
        break;
      }
      startIdx = i;
    }

    for (let i = startIdx; i < this.chatLines.length; i++) {
      const line = this.chatLines[i];
      this.renderChatLine(line);
    }

    if (this.streaming) {
      process.stderr.write(
        this.styleStreamingMessage(this.streamingBuffer) + '\n',
      );
    }
  }

  private renderChatLine(line: ChatLine): void {
    const icon = this.chatIcon(line.role);
    const styled = this.styleMessage(line.role, line.content);
    const wrapped = this.wrapText(this.stripAnsi(line.content), this.cols - 6);
    const prefix = `${icon} `;

    process.stderr.write(`${this.indent(prefix, 2)}${styled}\n`);
    wrapped.slice(1).forEach((w) => process.stderr.write(`${' '.repeat(2)}${this.styleContinuation(line.role, w)}\n`));
  }

  private styleMessage(role: ChatLine['role'], content: string): string {
    switch (role) {
      case 'user':
        return THEME.primary(content);
      case 'assistant':
        return THEME.accent(content);
      case 'tool':
        return THEME.secondary(content);
      case 'system':
        return THEME.muted(content);
      default:
        return content;
    }
  }

  private styleStreamingMessage(content: string): string {
    return THEME.accent(content);
  }

  private styleContinuation(role: ChatLine['role'], content: string): string {
    return this.styleMessage(role, content);
  }

  private chatIcon(role: ChatLine['role']): string {
    switch (role) {
      case 'user':
        return THEME.primary('◈');
      case 'assistant':
        return THEME.accent('▶');
      case 'tool':
        return THEME.warning('⚙');
      case 'system':
        return THEME.muted('·');
      default:
        return ' ';
    }
  }

  private formatToolResult(span: ToolSpan): string {
    const icon = span.isError ? THEME.error('✗') : THEME.success('✓');
    const dur = `${(span.durationMs / 1000).toFixed(1)}s`;
    return `${icon} ${THEME.bold(span.name)} ${THEME.secondary('(' + dur + ')')} ${THEME.secondary('→')} ${span.isError ? THEME.error(span.result) : THEME.secondary(span.result)}`;
  }

  private renderFooter(): void {
    if (!this.enabled) return;

    const tokens = `${THEME.secondary('in')} ${THEME.accent(formatTokens(this.usage.input))} ${THEME.secondary('→')} ${THEME.secondary('out')} ${THEME.accent(formatTokens(this.usage.output))}`;
    const turnInfo = `${THEME.secondary('turn')} ${THEME.accent(String(this.currentTurn))}${THEME.secondary('/')}${THEME.secondary(String(this.maxTurns))}`;
    const statusIcon = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
    const statusLabel =
      this.status === 'idle'
        ? THEME.success('● idle')
        : `${THEME.warning(statusIcon)} ${THEME.warning(this.status)}`;

    const left = `${THEME.secondary('Algorithme AI Agent')} ${turnInfo}`;
    const right = `${tokens}  ${statusLabel}`;

    process.stderr.write(`\u001b[${this.rows - 1};0H`);
    process.stderr.write(CLEAR_LINE);
    process.stderr.write(this.joinLeftRight(left, right, this.cols));
  }

  private joinLeftRight(left: string, right: string, width: number): string {
    const leftW = this.visibleWidth(left);
    const rightW = this.visibleWidth(right);
    const gap = width - leftW - rightW;
    if (gap >= 1) return left + ' '.repeat(gap) + right;
    if (leftW >= width) return this.truncate(left, width);
    return this.truncate(left + ' ' + right, width);
  }

  private visibleWidth(value: string): number {
    return this.stripAnsi(value).length;
  }

  private stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/g, '');
  }

  private pad(value: string, width: number): string {
    const gap = width - this.visibleWidth(value);
    return gap > 0 ? value + ' '.repeat(gap) : value;
  }

  private indent(text: string, spaces: number): string {
    return ' '.repeat(spaces) + text;
  }

  private truncate(value: string, max: number): string {
    if (this.visibleWidth(value) <= max) return value;
    const raw = this.stripAnsi(value);
    return `${raw.slice(0, Math.max(0, max - 1))}…`;
  }

  private wrapText(text: string, width: number): string[] {
    if (text.length <= width) return [text];
    const words = text.split(/(\s+)/);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      if (this.visibleWidth(current + word) <= width) {
        current += word;
      } else {
        if (current) lines.push(current.trimEnd());
        current = word;
      }
    }
    if (current) lines.push(current.trimEnd());
    return lines.length > 0 ? lines : [''];
  }

  private clearLine(): void {
    if (!this.enabled) return;
    process.stderr.write(`\r${CLEAR_LINE}`);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start the TUI: hide cursor, enter alt screen, render initial state. */
  start(): void {
    this.render();
  }

  /** Stop the TUI: show cursor, restore terminal. */
  stop(): void {
    if (this.spinner) {
      clearInterval(this.spinner);
      this.spinner = null;
    }
    this.streaming = false;
    if (this.enabled) {
      this.clearLine();
      process.stderr.write(EXIT_ALT_SCREEN);
      process.stderr.write(SHOW_CURSOR);
    }
    process.stderr.write('\n');
  }

  /** Write an error message in the chat area. */
  error(text: string): void {
    this.flushStreaming();
    this.chatLines.push({
      role: 'system',
      content: `Error: ${text}`,
      timestamp: Date.now(),
    });
    this.render();
  }

  /**
   * Set up keyboard handlers.
   * Returns a cleanup function.
   */
  setupKeyboard(): () => void {
    if (!this.enabled || !process.stdin.isTTY) return () => {};

    const stdin = process.stdin;
    if (stdin.isRaw === undefined) {
      stdin.setRawMode(true);
    }

    const handler = (data: Buffer) => {
      if (data.length === 1 && data[0] === 3) {
        // Ctrl+C
        process.kill(process.pid, 'SIGINT');
      }
      if (data.length === 1 && data[0] === 27) {
        // ESC - treat as exit
        process.kill(process.pid, 'SIGINT');
      }
    };

    stdin.on('data', handler);
    return () => {
      stdin.off('data', handler);
    };
  }

  /** Check if the TUI is active (TTY mode). */
  get isActive(): boolean {
    return this.enabled;
  }
}

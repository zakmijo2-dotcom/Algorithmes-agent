import chalk from 'chalk';

const THEME = {
  primary: chalk.cyan,
  accent: chalk.cyanBright,
  secondary: chalk.gray,
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  muted: chalk.gray,
  bold: chalk.bold,
};

export { THEME };

/** Strip ANSI SGR codes to measure the visible width of a styled string. */
export function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

export function visibleWidth(value: string): number {
  return stripAnsi(value).length;
}

export function pad(value: string, width: number): string {
  const gap = width - visibleWidth(value);
  return gap > 0 ? value + ' '.repeat(gap) : value;
}

/** Truncate a string (aware of ANSI styling) to `max` visible characters. */
export function truncate(value: string, max: number): string {
  if (visibleWidth(value) <= max) return value;
  const raw = stripAnsi(value);
  return `${raw.slice(0, Math.max(0, max - 1))}…`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function divider(width: number, char = '─', style = THEME.muted): string {
  return style(char.repeat(Math.max(0, width)));
}

/** Right-align `right` to `width`, joining with `left` when it fits. */
export function joinLeftRight(left: string, right: string, width: number): string {
  const leftW = visibleWidth(left);
  const rightW = visibleWidth(right);
  const gap = width - leftW - rightW;
  if (gap >= 1) return left + ' '.repeat(gap) + right;
  if (leftW >= width) return truncate(left, width);
  return truncate(left + ' ' + right, width);
}

export interface TableOptions {
  headers?: string[];
  rows: string[][];
  /** Column index to right-align (defaults to last). */
  rightAlign?: number;
}

const BORDER = THEME.secondary;

/**
 * Render an aligned table with box-drawing borders. Widths are computed from
 * the visible (ANSI-stripped) length of every cell, so colored cells align.
 */
export function table({ headers, rows, rightAlign }: TableOptions): string {
  const cols = Math.max(headers?.length ?? 0, ...rows.map((r) => r.length));
  const widths: number[] = new Array(cols).fill(0);
  for (let c = 0; c < cols; c++) {
    if (headers) widths[c] = Math.max(widths[c], visibleWidth(headers[c] ?? ''));
    for (const row of rows) widths[c] = Math.max(widths[c], visibleWidth(row[c] ?? ''));
  }

  const renderRow = (cells: string[], header = false): string => {
    const inner = cells
      .map((cell, c) => {
        const aligned =
          !header && rightAlign === c ? padRight(cell, widths[c]) : pad(cell, widths[c]);
        return header ? THEME.bold(aligned) : aligned;
      })
      .join(BORDER(' │ '));
    return `│ ${inner} │`;
  };

  const borderRow = (left: string, mid: string, right: string): string =>
    BORDER(`${left}${widths.map((w) => '─'.repeat(w)).join(mid)}${right}`);

  const lines: string[] = [];
  lines.push(borderRow('╭─', '─┬─', '─╮'));
  if (headers) {
    lines.push(renderRow(headers, true));
    lines.push(borderRow('├─', '─┼─', '─┤'));
  } else {
    lines.push(borderRow('├─', '─┬─', '─┤'));
  }
  for (let i = 0; i < rows.length; i++) {
    lines.push(renderRow(rows[i]));
    if (i < rows.length - 1) lines.push(borderRow('├─', '─┼─', '─┤'));
  }
  lines.push(borderRow('╰─', '─┴─', '─╯'));
  return lines.join('\n');
}

function padRight(value: string, width: number): string {
  const gap = width - visibleWidth(value);
  return gap > 0 ? ' '.repeat(gap) + value : value;
}

/**
 * Render a cyber-minimalist header box with double-line border accents.
 * Used for the startup banner and key status overlays.
 */
export function headerBox(title: string, subtitle: string, width: number, meta?: string): string {
  const inner = Math.max(1, width - 4);
  const bar = '━'.repeat(inner);
  const lines = [
    `${THEME.primary('┏━')}${THEME.secondary(bar)}${THEME.secondary('━┓')}`,
    `┃ ${pad(THEME.bold(THEME.accent(title)), inner)} ┃`,
    `┃ ${pad(THEME.secondary(subtitle), inner)} ┃`,
  ];
  if (meta) lines.push(`┃ ${pad(THEME.secondary(meta), inner)} ┃`);
  lines.push(`${THEME.primary('┗━')}${THEME.secondary(bar)}${THEME.secondary('━┛')}`);
  return lines.join('\n');
}

export function badge(text: string, color: (s: string) => string = THEME.primary): string {
  return color(` ${text} `);
}

export function check(ok: boolean): string {
  return ok ? THEME.success('✓') : THEME.error('✗');
}

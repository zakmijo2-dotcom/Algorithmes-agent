export type LineEnding = '\r\n' | '\n';

export function detectLineEnding(content: string): LineEnding {
  const crlfIdx = content.indexOf('\r\n');
  const lfIdx = content.indexOf('\n');
  if (lfIdx === -1) return '\n';
  if (crlfIdx === -1) return '\n';
  return crlfIdx < lfIdx ? '\r\n' : '\n';
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function restoreLineEndings(text: string, ending: LineEnding): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

/** Strip UTF-8 BOM if present, returning both the BOM and the text without it. */
export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith('\uFEFF') ? { bom: '\uFEFF', text: content.slice(1) } : { bom: '', text: content };
}

/**
 * Normalize text for fuzzy matching: strip trailing whitespace per line,
 * collapse smart quotes, dashes and special spaces to ASCII equivalents.
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize('NFKC')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
  );
}

export interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
  contentForReplacement: string;
}

/** Find `oldText` in `content`, trying exact match first, then fuzzy match. */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false, contentForReplacement: content };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
  }
  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
  };
}

/**
 * Exact-text replacement with safe failure modes.
 * `oldText` must appear exactly once; whitespace is matched exactly.
 */
export function applyReplacement(content: string, oldText: string, newText: string): string {
  if (oldText.length === 0) throw new Error('oldText must not be empty.');
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) {
    throw new Error(
      'Could not find the exact text. The old text must match exactly including all whitespace and newlines.',
    );
  }
  if (occurrences > 1) {
    throw new Error(
      `Found ${occurrences} occurrences of the text. The text must be unique; provide more context.`,
    );
  }
  return content.replace(oldText, newText);
}

// ---------------------------------------------------------------------------
// Line diff (self-contained, no external dependency)
// ---------------------------------------------------------------------------

type DiffOp = { type: 'added' | 'removed' | 'equal'; value: string };

function lcsIndices(a: string[], b: string[]): number[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push(i);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return result;
}

/** Compute an LCS line diff between two strings (both normalized to LF). */
export function diffLines(oldContent: string, newContent: string): DiffOp[] {
  const oldLines = oldContent === '' ? [] : oldContent.split('\n');
  const newLines = newContent === '' ? [] : newContent.split('\n');
  const common = lcsIndices(oldLines, newLines);

  const ops: DiffOp[] = [];
  const commonSet = new Set(common);
  let oi = 0;
  let ni = 0;
  let pendingOld: string[] = [];
  let pendingNew: string[] = [];

  const flush = (): void => {
    if (pendingOld.length > 0 || pendingNew.length > 0) {
      ops.push({ type: 'removed', value: pendingOld.join('\n') });
      ops.push({ type: 'added', value: pendingNew.join('\n') });
      pendingOld = [];
      pendingNew = [];
    }
  };

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && commonSet.has(oi) && oldLines[oi] === newLines[ni]) {
      flush();
      ops.push({ type: 'equal', value: oldLines[oi] });
      oi++;
      ni++;
    } else if (oi < oldLines.length && !commonSet.has(oi)) {
      pendingOld.push(oldLines[oi]);
      oi++;
    } else if (ni < newLines.length) {
      pendingNew.push(newLines[ni]);
      ni++;
    }
  }
  flush();
  return ops;
}

/**
 * Display-oriented diff with line numbers and context, no external dependency.
 * Returns the diff text plus the first changed line number in the new file.
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const parts = diffLines(normalizeToLF(oldContent), normalizeToLF(newContent));
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const width = String(maxLineNum).length;

  const output: string[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split('\n');

    if (part.type === 'added' || part.type === 'removed') {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;
      for (const line of raw) {
        if (part.type === 'added') {
          output.push(`+${String(newLineNum).padStart(width, ' ')} ${line}`);
          newLineNum++;
        } else {
          output.push(`-${String(oldLineNum).padStart(width, ' ')} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
      continue;
    }

    // Context lines: show a few before/after changes only.
    const nextIsChange = i < parts.length - 1 && (parts[i + 1].type === 'added' || parts[i + 1].type === 'removed');
    const hasLeadingChange = lastWasChange;
    const hasTrailingChange = nextIsChange;

    if (hasLeadingChange && hasTrailingChange) {
      if (raw.length <= contextLines * 2) {
        for (const line of raw) {
          output.push(` ${String(oldLineNum).padStart(width, ' ')} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      } else {
        const leading = raw.slice(0, contextLines);
        const trailing = raw.slice(raw.length - contextLines);
        const skipped = raw.length - leading.length - trailing.length;
        for (const line of leading) {
          output.push(` ${String(oldLineNum).padStart(width, ' ')} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
        output.push(` ${''.padStart(width, ' ')} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
        for (const line of trailing) {
          output.push(` ${String(oldLineNum).padStart(width, ' ')} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      }
    } else if (hasLeadingChange) {
      const shown = raw.slice(0, contextLines);
      const skipped = raw.length - shown.length;
      for (const line of shown) {
        output.push(` ${String(oldLineNum).padStart(width, ' ')} ${line}`);
        oldLineNum++;
        newLineNum++;
      }
      if (skipped > 0) {
        output.push(` ${''.padStart(width, ' ')} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
      }
    } else if (hasTrailingChange) {
      const skipped = Math.max(0, raw.length - contextLines);
      if (skipped > 0) {
        output.push(` ${''.padStart(width, ' ')} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
      }
      for (const line of raw.slice(skipped)) {
        output.push(` ${String(oldLineNum).padStart(width, ' ')} ${line}`);
        oldLineNum++;
        newLineNum++;
      }
    } else {
      oldLineNum += raw.length;
      newLineNum += raw.length;
    }
    lastWasChange = false;
  }

  return { diff: output.join('\n'), firstChangedLine };
}

// ---------------------------------------------------------------------------
// Truncation helpers
// ---------------------------------------------------------------------------

export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

export function truncateEnd(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function truncateLines(value: string, maxLines: number, marker = '…'): string {
  const lines = value.split('\n');
  if (lines.length <= maxLines) return value;
  return [...lines.slice(0, maxLines), marker].join('\n');
}

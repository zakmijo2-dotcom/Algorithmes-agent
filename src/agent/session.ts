import type { Message } from '../providers/base.js';

const CHARS_PER_TOKEN = 4;

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: Message): number {
  let chars = (message.content ?? '').length;
  for (const tc of message.tool_calls ?? []) {
    chars += tc.function.name.length + tc.function.arguments.length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export type EntryKind = 'root' | 'message' | 'compaction';

/**
 * One node in the session tree. Entries are immutable after insertion;
 * history is a tree (parentId links), so the agent can fork back to any
 * earlier message and explore an alternative lane.
 */
export interface SessionEntry {
  id: string;
  parentId: string | null;
  seq: number;
  timestamp: number;
  kind: EntryKind;
  /** Present when kind === 'message'. */
  message?: Message;
  /** Summary text when kind === 'compaction'. */
  summary?: string;
  /** Display-only label for branch points and forks. */
  label?: string;
  /** Estimated context tokens just before this compaction ran. */
  tokensBefore?: number;
  /** Recent messages kept verbatim on the compaction entry. */
  retainedTail?: Message[];
}

/** Compaction thresholds and retention settings. */
export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

/** Prepared compaction data, ready to be applied once a summary is generated. */
export interface CompactionPreparation {
  /** Index (in the current path) of the first entry kept after compaction. */
  cutIndex: number;
  /** Messages that should be summarized away. */
  messagesToSummarize: Message[];
  /** Recent messages retained verbatim on the compaction entry. */
  retainedTail: Message[];
  /** Summary of the previous compaction, for iterative updates. */
  previousSummary?: string;
  /** Estimated context tokens before compaction. */
  tokensBefore: number;
}

let idCounter = 0;
let seqCounter = 0;
function nextId(): string {
  return `e${++idCounter}`;
}
function nextSeq(): number {
  return ++seqCounter;
}

/**
 * In-memory session tree. The conversation is a tree of entries rooted at a
 * synthetic root node. `current` is the cursor used for appends and rebuilds.
 * Compaction inserts a `compaction` entry on the path whose summary + retained
 * tail stand in for the older messages; the pre-compaction subtree remains as
 * an alternate lane.
 */
export class SessionTree {
  private readonly entriesById = new Map<string, SessionEntry>();
  private readonly childrenById = new Map<string, string[]>();
  private current: string;
  rootId: string;

  constructor(private readonly contextWindow: number = 48_000) {
    const root: SessionEntry = {
      id: nextId(),
      parentId: null,
      seq: nextSeq(),
      timestamp: Date.now(),
      kind: 'root',
    };
    this.entriesById.set(root.id, root);
    this.childrenById.set(root.id, []);
    this.rootId = root.id;
    this.current = root.id;
  }

  get currentId(): string {
    return this.current;
  }

  get size(): number {
    return this.path().filter((e) => e.kind !== 'root').length;
  }

  get length(): number {
    return this.entriesById.size;
  }

  /** Ids of all current leaves (lanes) in the tree. */
  get leaves(): string[] {
    const leaves: string[] = [];
    for (const entry of this.entriesById.values()) {
      if (this.childrenById.get(entry.id)?.length === 0) leaves.push(entry.id);
    }
    return leaves;
  }

  has(id: string): boolean {
    return this.entriesById.has(id);
  }

  get(id: string): SessionEntry | undefined {
    return this.entriesById.get(id);
  }

  /** Walk from `id` to the root, returning entries oldest-first. */
  path(id: string = this.current): SessionEntry[] {
    const out: SessionEntry[] = [];
    let cur = this.entriesById.get(id);
    if (!cur) throw new Error(`Session entry not found: ${id}`);
    while (cur) {
      out.push(cur);
      if (cur.parentId === null) break;
      const next = this.entriesById.get(cur.parentId);
      if (!next) throw new Error(`Session entry not found: ${id}`);
      cur = next;
    }
    return out.reverse();
  }

  /** Rebuild the conversation messages for a given path id. */
  build(id: string = this.current): Message[] {
    const out: Message[] = [];
    for (const entry of this.path(id)) {
      if (entry.kind === 'root') continue;
      if (entry.kind === 'message' && entry.message) {
        out.push(entry.message);
      } else if (entry.kind === 'compaction') {
        if (entry.summary) {
          out.push({
            role: 'user',
            content: COMPACTION_SUMMARY_PREFIX + entry.summary + COMPACTION_SUMMARY_SUFFIX,
          });
        }
        for (const tail of entry.retainedTail ?? []) out.push(tail);
      }
    }
    return out;
  }

  /** Estimated context tokens for the rebuilt conversation on a path. */
  estimatedTokens(id: string = this.current): number {
    let total = 0;
    for (const message of this.build(id)) total += estimateTokens(message);
    return total;
  }

  /** Append a message to the current cursor; moves the cursor forward. */
  append(message: Message): SessionEntry {
    const entry: SessionEntry = {
      id: nextId(),
      parentId: this.current,
      seq: nextSeq(),
      timestamp: Date.now(),
      kind: 'message',
      message,
    };
    this.entriesById.set(entry.id, entry);
    this.childrenById.get(this.current)!.push(entry.id);
    this.childrenById.set(entry.id, []);
    this.current = entry.id;
    return entry;
  }

  /**
   * Move the cursor to `id`. Subsequent appends branch from there, leaving the
   * old continuation as an alternate lane.
   */
  select(id: string): void {
    if (!this.entriesById.has(id)) throw new Error(`Session entry not found: ${id}`);
    this.current = id;
  }

  /**
   * Create a branch from `atEntryId` (defaults to the current cursor position).
   * The cursor moves to a new leaf below `atEntryId`, ready for appends.
   */
  fork(atEntryId: string = this.current): string {
    const target = this.entriesById.get(atEntryId);
    if (!target) throw new Error(`Session entry not found: ${atEntryId}`);
    if (target.kind !== 'message') throw new Error(`Fork target is not a message entry: ${atEntryId}`);

    const branch = this.entriesById.get(this.current);
    const label = branch?.kind === 'message' ? `(fork from ${atEntryId.slice(-4)})` : '(fork)';
    const marker: SessionEntry = {
      id: nextId(),
      parentId: atEntryId,
      seq: nextSeq(),
      timestamp: Date.now(),
      kind: 'compaction',
      label,
    };
    this.entriesById.set(marker.id, marker);
    this.childrenById.get(atEntryId)!.push(marker.id);
    this.childrenById.set(marker.id, []);
    this.current = marker.id;
    return marker.id;
  }

  /** Reset the tree to a single empty root. */
  clear(): void {
    this.entriesById.clear();
    this.childrenById.clear();
    const root: SessionEntry = {
      id: nextId(),
      parentId: null,
      seq: nextSeq(),
      timestamp: Date.now(),
      kind: 'root',
    };
    this.entriesById.set(root.id, root);
    this.childrenById.set(root.id, []);
    this.rootId = root.id;
    this.current = root.id;
  }

  /** Whether the current path exceeds the compaction threshold. */
  needsCompaction(settings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS): boolean {
    if (!settings.enabled) return false;
    return this.estimatedTokens() > this.contextWindow - settings.reserveTokens;
  }

  /**
   * Pick a cut point on the current path for compaction. Returns undefined when
   * there is nothing to compact (empty path or last entry already compacted).
   */
  prepareCompaction(
    settings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS,
  ): CompactionPreparation | undefined {
    const path = this.path();
    const relevant = path.filter((e) => e.kind !== 'root');
    if (relevant.length === 0) return undefined;
    if (relevant[relevant.length - 1].kind === 'compaction') return undefined;

    // Find the newest compaction on the path for iterative summaries.
    let previousSummary: string | undefined;
    for (const entry of relevant) {
      if (entry.kind === 'compaction' && entry.summary) previousSummary = entry.summary;
    }

    const tokensBefore = this.estimatedTokens();

    // Walk backwards from the end, keeping roughly `keepRecentTokens`.
    let kept = 0;
    let cutIndex = relevant.length;
    for (let i = relevant.length - 1; i >= 0; i--) {
      const entry = relevant[i];
      const cost = estimateTokens(entry.message ?? { role: 'user', content: '' });
      if (entry.kind === 'compaction') {
        for (const tail of entry.retainedTail ?? []) kept += estimateTokens(tail);
        if (entry.summary) kept += estimateTokens({ role: 'user', content: entry.summary });
      } else if (entry.message) {
        kept += cost;
      }
      if (kept >= settings.keepRecentTokens) {
        cutIndex = i + 1;
        break;
      }
      cutIndex = i;
    }

    // Never leave a dangling tool message at the head of the retained tail.
    while (cutIndex < relevant.length && relevant[cutIndex].message?.role === 'tool') cutIndex++;

    // Always keep at least the most recent message verbatim.
    if (cutIndex >= relevant.length) cutIndex = Math.max(0, relevant.length - 1);

    const messagesToSummarize: Message[] = [];
    for (let i = 0; i < cutIndex; i++) {
      const message = relevant[i].message;
      if (message && relevant[i].kind === 'message') messagesToSummarize.push(message);
    }
    const retainedTail: Message[] = [];
    for (let i = cutIndex; i < relevant.length; i++) {
      const message = relevant[i].message;
      if (message && relevant[i].kind === 'message') retainedTail.push(message);
    }

    if (messagesToSummarize.length === 0) return undefined;

    return { cutIndex, messagesToSummarize, retainedTail, previousSummary, tokensBefore };
  }

  /**
   * Apply a prepared compaction: insert a compaction entry below the parent of
   * the first summarized message and move the cursor onto it. The summarized
   * subtree stays in the tree as an alternate lane.
   */
  applyCompaction(preparation: CompactionPreparation, summary: string): SessionEntry {
    const path = this.path();
    const relevant = path.filter((e) => e.kind !== 'root');
    const firstSummarized = relevant[preparation.cutIndex - 1];
    if (!firstSummarized) throw new Error('Compaction cut index is out of range.');
    const parentId = firstSummarized.parentId ?? this.rootId;

    const entry: SessionEntry = {
      id: nextId(),
      parentId,
      seq: nextSeq(),
      timestamp: Date.now(),
      kind: 'compaction',
      summary,
      tokensBefore: preparation.tokensBefore,
      retainedTail: preparation.retainedTail,
    };
    this.entriesById.set(entry.id, entry);
    this.childrenById.get(parentId)!.push(entry.id);
    this.childrenById.set(entry.id, []);
    this.current = entry.id;
    return entry;
  }
}

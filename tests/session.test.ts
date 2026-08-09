import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTree, estimateTokens, DEFAULT_COMPACTION_SETTINGS } from '../src/agent/session.js';
import type { Message } from '../src/providers/base.js';

describe('estimateTokens', () => {
  it('counts characters at ~4 per token', () => {
    const message: Message = { role: 'user', content: 'hello world' };
    expect(estimateTokens(message)).toBe(Math.ceil(11 / 4));
  });

  it('accounts for tool calls in the token estimate', () => {
    const message: Message = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'doThing', arguments: '{"key":"value"}' } },
      ],
    };
    const chars = 'doThing'.length + '{"key":"value"}'.length;
    expect(estimateTokens(message)).toBe(Math.ceil(chars / 4));
  });

  it('handles empty content', () => {
    const message: Message = { role: 'system', content: '' };
    expect(estimateTokens(message)).toBe(0);
  });
});

describe('SessionTree', () => {
  let tree: SessionTree;

  beforeEach(() => {
    tree = new SessionTree();
  });

  describe('constructor', () => {
    it('starts with a single root entry', () => {
      expect(tree.length).toBe(1);
      expect(tree.size).toBe(0);
      expect(tree.rootId).toBeDefined();
      expect(tree.currentId).toBe(tree.rootId);
    });

    it('current entry is root initially', () => {
      expect(tree.get(tree.currentId)?.kind).toBe('root');
    });

    it('accepts a custom context window', () => {
      const small = new SessionTree(1_000);
      expect(small.estimatedTokens()).toBe(0);
    });
  });

  describe('append', () => {
    it('appends a message and advances the cursor', () => {
      const msg: Message = { role: 'user', content: 'hello' };
      const entry = tree.append(msg);
      expect(entry.kind).toBe('message');
      expect(entry.message).toBe(msg);
      expect(tree.size).toBe(1);
      expect(tree.currentId).toBe(entry.id);
    });

    it('path walks from root to current in order', () => {
      const tree = new SessionTree();
      const e1 = tree.append({ role: 'user', content: 'first' });
      const e2 = tree.append({ role: 'assistant', content: 'second' });
      const path = tree.path();
      expect(path.map((e) => e.id)).toEqual([tree.rootId, e1.id, e2.id]);
    });
  });

  describe('leaves', () => {
    it('starts with the root as the only leaf', () => {
      expect(tree.leaves).toEqual([tree.rootId]);
    });

    it('reports new leaf after append', () => {
      const entry = tree.append({ role: 'user', content: 'hi' });
      expect(tree.leaves).toEqual([entry.id]);
    });
  });

  describe('build', () => {
    it('reconstructs messages excluding root', () => {
      const msg1: Message = { role: 'user', content: 'hello' };
      const msg2: Message = { role: 'assistant', content: 'hi there' };
      tree.append(msg1);
      tree.append(msg2);
      expect(tree.build()).toEqual([msg1, msg2]);
    });

    it('includes compaction summaries and retained tails', () => {
      const tree = new SessionTree();
      for (let i = 0; i < 20; i++) {
        tree.append({ role: 'user', content: `message ${i} ` + 'x'.repeat(1_000) });
      }

      const prep = tree.prepareCompaction({ enabled: true, reserveTokens: 0, keepRecentTokens: 100 });
      expect(prep).toBeDefined();
      tree.applyCompaction(prep!, 'A summary of the conversation.');

      const built = tree.build();
      expect(built.some((m) => m.content?.includes('A summary of the conversation.') ?? false)).toBe(true);
      expect(built.some((m) => m.content === 'message 19 ' + 'x'.repeat(1_000))).toBe(true);
    });
  });

  describe('get', () => {
    it('returns undefined for unknown id', () => {
      expect(tree.get('nonexistent')).toBeUndefined();
    });

    it('returns the entry for a known id', () => {
      const entry = tree.append({ role: 'user', content: 'msg' });
      expect(tree.get(entry.id)).toBe(entry);
    });
  });

  describe('has', () => {
    it('returns true for root', () => {
      expect(tree.has(tree.rootId)).toBe(true);
    });

    it('returns false for unknown id', () => {
      expect(tree.has('nonexistent')).toBe(false);
    });
  });

  describe('select', () => {
    it('throws for unknown id', () => {
      expect(() => tree.select('nonexistent')).toThrow('Session entry not found');
    });

    it('moves the cursor', () => {
      const e1 = tree.append({ role: 'user', content: 'first' });
      tree.append({ role: 'assistant', content: 'second' });
      tree.select(e1.id);
      expect(tree.currentId).toBe(e1.id);
      tree.append({ role: 'user', content: 'branched' });
      expect(tree.leaves).toHaveLength(2);
    });
  });

  describe('fork', () => {
    it('creates a new branch and moves cursor', () => {
      const msg = tree.append({ role: 'assistant', content: 'reply' });
      const forkId = tree.fork(msg.id);
      expect(tree.currentId).toBe(forkId);
      expect(tree.get(forkId)?.kind).toBe('compaction');
      expect(tree.get(forkId)?.label).toContain('fork');
    });

    it('throws when forking a non-message entry', () => {
      expect(() => tree.fork(tree.rootId)).toThrow('Fork target is not a message');
    });
  });

  describe('clear', () => {
    it('resets to a single root', () => {
      tree.append({ role: 'user', content: 'msg1' });
      tree.append({ role: 'assistant', content: 'msg2' });
      expect(tree.length).toBe(3);
      tree.clear();
      expect(tree.length).toBe(1);
      expect(tree.size).toBe(0);
      expect(tree.currentId).toBe(tree.rootId);
    });
  });

  describe('estimatedTokens', () => {
    it('sums token estimates across the path', () => {
      const msg: Message = { role: 'user', content: 'hello world' };
      tree.append(msg);
      expect(tree.estimatedTokens()).toBe(estimateTokens(msg));
    });

    it('returns 0 for a fresh tree', () => {
      expect(new SessionTree().estimatedTokens()).toBe(0);
    });
  });

  describe('needsCompaction', () => {
    it('returns false when compaction is disabled', () => {
      tree.append({ role: 'user', content: 'x'.repeat(100_000) });
      expect(tree.needsCompaction({ enabled: false, reserveTokens: 0, keepRecentTokens: 0 })).toBe(false);
    });

    it('returns false when tokens are below threshold', () => {
      tree.append({ role: 'user', content: 'short' });
      expect(tree.needsCompaction()).toBe(false);
    });

    it('returns true when estimated tokens exceed threshold', () => {
      const smallWindow = new SessionTree(10_000);
      smallWindow.append({ role: 'user', content: 'x'.repeat(100_000) });
      expect(smallWindow.needsCompaction()).toBe(true);
    });
  });

  describe('prepareCompaction', () => {
    it('returns undefined when there are no messages', () => {
      expect(tree.prepareCompaction()).toBeUndefined();
    });

    it('returns undefined when last entry is already a compaction', () => {
      const t = new SessionTree();
      for (let i = 0; i < 20; i++) {
        t.append({ role: 'user', content: `message ${i} ` + 'x'.repeat(1_000) });
      }
      const prep = t.prepareCompaction({ enabled: true, reserveTokens: 0, keepRecentTokens: 100 });
      expect(prep).toBeDefined();
      t.applyCompaction(prep!, 'summary');
      expect(t.prepareCompaction({ enabled: true, reserveTokens: 0, keepRecentTokens: 0 })).toBeUndefined();
    });

    it('always keeps at least one message in the retained tail', () => {
      const t = new SessionTree();
      for (let i = 0; i < 10; i++) {
        t.append({ role: 'user', content: `message number ${i}` });
      }
      const prep = t.prepareCompaction({ enabled: true, reserveTokens: 0, keepRecentTokens: 0 });
      expect(prep).toBeDefined();
      expect(prep!.retainedTail.length).toBeGreaterThan(0);
    });

    it('returns messages to summarize and messages to retain', () => {
      const t = new SessionTree();
      for (let i = 0; i < 20; i++) {
        t.append({ role: 'user', content: `message ${i} ` + 'x'.repeat(500) });
      }
      const prep = t.prepareCompaction({ enabled: true, reserveTokens: 0, keepRecentTokens: 20 });
      expect(prep).toBeDefined();
      expect(prep!.messagesToSummarize.length).toBeGreaterThan(0);
      expect(prep!.retainedTail.length).toBeGreaterThan(0);
    });
  });

  describe('applyCompaction', () => {
    it('throws when cut index is out of range', () => {
      expect(() =>
        tree.applyCompaction({ cutIndex: 0, messagesToSummarize: [], retainedTail: [], tokensBefore: 0 }, 's'),
      ).toThrow('Compaction cut index is out of range');
    });

    it('inserts compaction entry and moves cursor', () => {
      const t = new SessionTree();
      for (let i = 0; i < 20; i++) {
        t.append({ role: 'user', content: `message ${i} ` + 'x'.repeat(1_000) });
      }
      const prep = t.prepareCompaction({ enabled: true, reserveTokens: 0, keepRecentTokens: 100 })!;
      const entry = t.applyCompaction(prep, 'summary text');
      expect(entry.kind).toBe('compaction');
      expect(entry.summary).toBe('summary text');
      expect(t.currentId).toBe(entry.id);
    });
  });

  describe('DAG branching & lanes', () => {
    it('forks create independent lanes', () => {
      const base = tree.append({ role: 'user', content: 'start' });
      tree.append({ role: 'assistant', content: 'reply1' });

      const forkA = tree.fork(base.id);
      tree.append({ role: 'assistant', content: 'reply-a' });
      const leafA = tree.currentId;

      tree.select(base.id);
      const forkB = tree.fork(base.id);
      tree.append({ role: 'assistant', content: 'reply-b' });
      const leafB = tree.currentId;

      expect(tree.leaves).toContain(leafA);
      expect(tree.leaves).toContain(leafB);
      expect(tree.leaves).toHaveLength(3);

      tree.select(leafA);
      expect(tree.build()).toEqual(
        expect.arrayContaining([{ role: 'user', content: 'start' }, { role: 'assistant', content: 'reply-a' }]),
      );

      tree.select(leafB);
      expect(tree.build()).toEqual(
        expect.arrayContaining([{ role: 'user', content: 'start' }, { role: 'assistant', content: 'reply-b' }]),
      );
    });

    it('path(id) returns the path to a specific lane', () => {
      const base = tree.append({ role: 'user', content: 'shared' });
      const forkId = tree.fork(base.id);
      tree.append({ role: 'assistant', content: 'lane reply' });

      const path = tree.path(forkId);
      const messages = path.filter((e) => e.kind === 'message');
      expect(messages.map((m) => m.message?.content)).toEqual(['shared']);
    });

    it('path(currentId) includes messages appended after a fork', () => {
      const base = tree.append({ role: 'user', content: 'shared' });
      tree.fork(base.id);
      tree.append({ role: 'assistant', content: 'lane reply' });

      const path = tree.path();
      const messages = path.filter((e) => e.kind === 'message');
      expect(messages.map((m) => m.message?.content)).toEqual(['shared', 'lane reply']);
    });
  });
});

describe('DEFAULT_COMPACTION_SETTINGS', () => {
  it('has expected values', () => {
    expect(DEFAULT_COMPACTION_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_COMPACTION_SETTINGS.reserveTokens).toBe(16_384);
    expect(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens).toBe(20_000);
  });
});

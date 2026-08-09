import { describe, it, expect } from 'vitest';
import { SessionTree, estimateTokens } from './session.js';
import type { Message } from '../providers/base.js';

describe('estimateTokens', () => {
  it('counts characters at ~4 per token', () => {
    const message: Message = { role: 'user', content: 'hello world' };
    expect(estimateTokens(message)).toBe(Math.ceil(11 / 4));
  });

  it('accounts for tool calls', () => {
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
  describe('constructor & basic accessors', () => {
    it('starts with a single root entry', () => {
      const tree = new SessionTree();
      expect(tree.length).toBe(1);
      expect(tree.size).toBe(0);
      expect(tree.rootId).toBeDefined();
      expect(tree.currentId).toBe(tree.rootId);
    });

    it('reports current entry as the root initially', () => {
      const tree = new SessionTree();
      expect(tree.get(tree.currentId)?.kind).toBe('root');
    });
  });

  describe('append', () => {
    it('appends a message and advances the cursor', () => {
      const tree = new SessionTree();
      const msg: Message = { role: 'user', content: 'hello' };
      const entry = tree.append(msg);
      expect(entry.kind).toBe('message');
      expect(entry.message).toBe(msg);
      expect(tree.size).toBe(1);
      expect(tree.currentId).toBe(entry.id);
    });

    it('path walks from root to current', () => {
      const tree = new SessionTree();
      const e1 = tree.append({ role: 'user', content: 'first' });
      const e2 = tree.append({ role: 'assistant', content: 'second' });
      const path = tree.path();
      expect(path.map((e) => e.id)).toEqual([tree.rootId, e1.id, e2.id]);
    });
  });

  describe('leaves', () => {
    it('starts with the root as the only leaf', () => {
      const tree = new SessionTree();
      expect(tree.leaves).toEqual([tree.rootId]);
    });

    it('reports new leaf after append', () => {
      const tree = new SessionTree();
      const entry = tree.append({ role: 'user', content: 'hi' });
      expect(tree.leaves).toEqual([entry.id]);
    });
  });

  describe('build', () => {
    it('reconstructs messages excluding root', () => {
      const tree = new SessionTree();
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

  describe('select', () => {
    it('throws for unknown id', () => {
      const tree = new SessionTree();
      expect(() => tree.select('nonexistent')).toThrow('Session entry not found');
    });

    it('moves the cursor', () => {
      const tree = new SessionTree();
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
      const tree = new SessionTree();
      const msg = tree.append({ role: 'assistant', content: 'reply' });
      const forkId = tree.fork(msg.id);
      expect(tree.currentId).toBe(forkId);
      expect(tree.get(forkId)?.kind).toBe('compaction');
      expect(tree.get(forkId)?.label).toContain('fork');
    });

    it('throws when forking a non-message entry', () => {
      const tree = new SessionTree();
      expect(() => tree.fork(tree.rootId)).toThrow('Fork target is not a message');
    });
  });

  describe('clear', () => {
    it('resets to a single root', () => {
      const tree = new SessionTree();
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
      const tree = new SessionTree();
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
      const tree = new SessionTree();
      tree.append({ role: 'user', content: 'x'.repeat(100_000) });
      expect(tree.needsCompaction({ enabled: false, reserveTokens: 0, keepRecentTokens: 0 })).toBe(false);
    });

    it('returns true when estimated tokens exceed threshold', () => {
      const tree = new SessionTree(10_000);
      tree.append({ role: 'user', content: 'x'.repeat(100_000) });
      expect(tree.needsCompaction()).toBe(true);
    });
  });

  describe('prepareCompaction', () => {
    it('returns undefined when there are no messages', () => {
      const tree = new SessionTree();
      expect(tree.prepareCompaction()).toBeUndefined();
    });

    it('returns undefined when last entry is already a compaction', () => {
      const tree = new SessionTree();
      for (let i = 0; i < 20; i++) {
        tree.append({ role: 'user', content: `message ${i} ` + 'x'.repeat(1_000) });
      }
      const prep = tree.prepareCompaction({ enabled: true, reserveTokens: 0, keepRecentTokens: 100 });
      expect(prep).toBeDefined();
      tree.applyCompaction(prep!, 'summary');
      expect(tree.prepareCompaction({ enabled: true, reserveTokens: 0, keepRecentTokens: 0 })).toBeUndefined();
    });

    it('always keeps at least one message in the retained tail', () => {
      const tree = new SessionTree();
      for (let i = 0; i < 10; i++) {
        tree.append({ role: 'user', content: `message number ${i}` });
      }
      const prep = tree.prepareCompaction({ enabled: true, reserveTokens: 0, keepRecentTokens: 0 });
      expect(prep).toBeDefined();
      expect(prep!.retainedTail.length).toBeGreaterThan(0);
    });
  });

  describe('applyCompaction', () => {
    it('throws when cut index is out of range', () => {
      const tree = new SessionTree();
      expect(() => tree.applyCompaction({ cutIndex: 0, messagesToSummarize: [], retainedTail: [], tokensBefore: 0 }, 's')).toThrow(
        'Compaction cut index is out of range',
      );
    });

    it('inserts compaction entry and moves cursor', () => {
      const tree = new SessionTree();
      for (let i = 0; i < 20; i++) {
        tree.append({ role: 'user', content: `message ${i} ` + 'x'.repeat(1_000) });
      }
      const prep = tree.prepareCompaction({ enabled: true, reserveTokens: 0, keepRecentTokens: 100 })!;
      const entry = tree.applyCompaction(prep, 'summary text');
      expect(entry.kind).toBe('compaction');
      expect(entry.summary).toBe('summary text');
      expect(tree.currentId).toBe(entry.id);
    });
  });
});

describe('SessionTree contextWindow', () => {
  it('respects a custom context window size', () => {
    const small = new SessionTree(1_000);
    small.append({ role: 'user', content: 'x'.repeat(2_000) });
    expect(small.needsCompaction()).toBe(true);

    const large = new SessionTree(1_000_000);
    large.append({ role: 'user', content: 'x'.repeat(2_000) });
    expect(large.needsCompaction()).toBe(false);
  });
});

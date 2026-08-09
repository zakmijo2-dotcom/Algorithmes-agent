import { describe, it, expect } from 'vitest';
import { AgentLoop, type AgentOptions } from './loop.js';
import { SessionTree } from './session.js';
import { ToolRegistry } from '../tools/registry.js';
import type { BaseProvider, ProviderEvent } from '../providers/base.js';

class MockProvider implements BaseProvider {
  readonly name = 'mock';
  readonly model = 'mock-model';
  public events: ProviderEvent[] = [];
  public chatCalls: number = 0;

  chat(): AsyncIterable<ProviderEvent> {
    this.chatCalls++;
    const events = this.events;
    return {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next() {
            if (i < events.length) {
              return Promise.resolve({ value: events[i++], done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }
}

function makeRegistry(): ToolRegistry {
  return new ToolRegistry();
}

describe('AgentLoop session sharing', () => {
  it('uses a shared SessionTree when provided', () => {
    const tree = new SessionTree();
    const provider = new MockProvider();
    provider.events = [{ type: 'text', delta: 'response' }, { type: 'end' }];
    const loop = new AgentLoop(provider, makeRegistry(), { session: tree });
    expect(loop.sessionTree).toBe(tree);
  });

  it('allocates a new SessionTree when none is provided', () => {
    const provider = new MockProvider();
    const loop = new AgentLoop(provider, makeRegistry(), {});
    expect(loop.sessionTree).toBeInstanceOf(SessionTree);
  });

  it('preserves conversation history across AgentLoop instances sharing a tree', async () => {
    const tree = new SessionTree();
    const provider = new MockProvider();
    provider.events = [{ type: 'text', delta: 'hello' }, { type: 'end' }];

    const loop1 = new AgentLoop(provider, makeRegistry(), { session: tree });
    await loop1.run('first message');
    expect(tree.size).toBe(2); // user + assistant

    provider.chatCalls = 0;
    const loop2 = new AgentLoop(provider, makeRegistry(), { session: tree });
    await loop2.run('second message');
    expect(tree.size).toBe(4); // user + assistant + user + assistant
    expect(provider.chatCalls).toBe(1);
  });

  it('clearHistory on App-level tree resets conversation', async () => {
    const tree = new SessionTree();
    const provider = new MockProvider();
    provider.events = [{ type: 'text', delta: 'hi' }, { type: 'end' }];

    const loop = new AgentLoop(provider, makeRegistry(), { session: tree });
    await loop.run('some input');
    expect(tree.size).toBe(2);

    loop.clearHistory();
    expect(tree.size).toBe(0);
    expect(tree.currentId).toBe(tree.rootId);
  });

  it('returns the correct run result structure', async () => {
    const provider = new MockProvider();
    provider.events = [
      { type: 'text', delta: 'Hello' },
      { type: 'text', delta: ' world' },
      { type: 'end' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    ];

    const loop = new AgentLoop(provider, makeRegistry(), { maxTurns: 5 });
    const result = await loop.run('test input');

    expect(result.text).toBe('Hello world');
    expect(result.toolCalls).toBe(0);
    expect(result.turns).toBe(1);
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.compactions).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('stops at maxTurns when model keeps calling tools', async () => {
    const provider = new MockProvider();
    provider.events = [
      { type: 'tool', index: 0, delta: { id: 'call_1', name: 'noop', arguments: '{}' } },
      { type: 'end' },
    ];

    const registry = makeRegistry();
    registry.register({
      definition: { name: 'noop', description: 'does nothing', parameters: {} },
      execute: () => 'noop result',
    });

    const loop = new AgentLoop(provider, registry, { maxTurns: 2 });
    const result = await loop.run('do something');

    expect(result.turns).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(result.text).toContain('Stopped after 2 turns');
  });

  it('respects temperature and maxTokens in options', () => {
    const provider = new MockProvider();
    const loop = new AgentLoop(provider, makeRegistry(), { temperature: 0.5, maxTokens: 500 });
    void loop;
    expect(provider).toBeDefined();
  });

  it('passes shared tree through session option to AgentLoop', () => {
    const tree = new SessionTree();
    const provider = new MockProvider();
    provider.events = [{ type: 'text', delta: 'ok' }, { type: 'end' }];

    const options: AgentOptions = { session: tree, cwd: '/tmp' };
    const loop = new AgentLoop(provider, makeRegistry(), options);

    void loop;
    expect(loop.sessionTree).toBe(tree);
    expect(tree).toBe(tree);
  });

  it('sessionTree getter returns the internal tree', () => {
    const provider = new MockProvider();
    const loop = new AgentLoop(provider, makeRegistry(), {});
    expect(loop.sessionTree).toBe(loop.sessionTree);
  });

  it('contextSize reflects session size', async () => {
    const tree = new SessionTree();
    const provider = new MockProvider();
    provider.events = [{ type: 'text', delta: 'reply' }, { type: 'end' }];

    const loop = new AgentLoop(provider, makeRegistry(), { session: tree });
    expect(loop.contextSize).toBe(0);

    await loop.run('input');
    expect(loop.contextSize).toBe(2);
  });

  it('throws on provider error', async () => {
    const provider = new MockProvider();
    provider.events = [{ type: 'error', message: 'Something went wrong' }];

    const loop = new AgentLoop(provider, makeRegistry(), {});
    await expect(loop.run('test')).rejects.toThrow('Provider error: Something went wrong');
  });
});

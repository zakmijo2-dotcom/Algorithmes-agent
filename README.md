<div align="center">

# Algorithme AI Agent

**Deterministic & Secure Multi-Provider Coding Harness**

A production-grade terminal coding agent with a minimal agent loop, zero bloat,
deterministic tool calls, and a pluggable multi-provider + skills/plugins
architecture — hardened with a built-in security & guardrails layer.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D18.17-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

</div>

---

## Highlights

- **Deterministic agent loop** — `user input → system prompt + tools → stream → execute tools → append results → repeat`, with tool failures fed back to the model for self-correction.
- **Secure by default** — sandboxed file access (path traversal + symlink protection), a shell command guard (no `rm -rf /`, `mkfs`, credential dumps, privilege escalation), and automatic secret masking in streams, logs, and history.
- **Multi-provider, one interface** — a single streaming contract (`BaseProvider.chat`) over **OpenRouter**, **Groq**, and local **Ollama**. Pick any provider + model with one string ID.
- **Zero-bloat core** — no vendor SDKs. Providers are thin SSE streams over the OpenAI-compatible API using native `fetch`.
- **Native file tools** — `read`, `write`, `edit`, `bash`, `diff` — auto-registered, cwd-aware, sandboxed.
- **Sub-agents** — the model can delegate isolated tasks to nested sub-agents (bounded depth) that run with fresh context and report back.
- **Skills** — drop JSON/YAML/TS skill packs into `.algorithme/skills`; every command becomes an agent tool.
- **Plugins** — lifecycle hooks (`onAgentStart`, `onTurnStart`, `beforeToolCall`, `afterToolCall`, `onCompaction`, `onTurnEnd`) loaded from `.algorithme/plugins`, with blockable tool calls and result mutation.
- **Session tree** — history is a branching tree, not a flat buffer: fork from any message (`/fork`), list lanes (`/lanes`), switch between branches (`/go`).
- **Termux ready** — runs natively on Android's Termux; shell detection adapts automatically.
- **Polished CLI UI** — live token streaming, spinner, tool-call tracing, per-turn timing and token accounting.

---

## Quick start

### 1. Install

```bash
npm install
npm run build
```

### 2. Configure a provider

Copy the example to `.env` and set at least one key:

```bash
# OpenRouter (default) — https://openrouter.ai/keys
OPENROUTER_API_KEY=sk-or-...

# Groq (optional) — https://console.groq.com/keys
GROQ_API_KEY=gsk_...

# Ollama (optional, local) — https://ollama.com
OLLAMA_BASE_URL=http://localhost:11434/v1

# Default model id (optional)
ALGORITHME_MODEL=openrouter:deepseek/deepseek-r1
```

> `PI_MODEL` is still honoured as a legacy fallback for `ALGORITHME_MODEL`.

> No key? Point `OLLAMA_BASE_URL` at a running Ollama instance and use `ollama:llama3`.

### 3. Run it

```bash
# Single-shot: fix a bug, refactor a file, answer a question
npm run dev -- "fix the bug in src/agent/loop.ts"

# Interactive chat
npm run dev

# Compiled binary / global install (commands: algorithme / alg)
npm run build && npm start -- --help
npm install -g . && algorithme "explain this repo"
alg --help
```

---

## CLI reference

```
Usage: algorithme [options] [prompt...]
```

| Option | Description | Default |
| --- | --- | --- |
| `[prompt...]` | Prompt for single-shot mode. Omit for interactive chat. | — |
| `-m, --model <id>` | Provider + model id, e.g. `groq:llama-3.3-70b-versatile`, `ollama:llama3`. | `$ALGORITHME_MODEL` or `openrouter:deepseek/deepseek-r1` |
| `-c, --cwd <dir>` | Working directory the agent operates in. | `process.cwd()` |
| `-s, --system <text>` | Override the system prompt. | built-in |
| `-t, --temperature <n>` | Sampling temperature. | `0.0` |
| `--max-turns <n>` | Maximum agent-loop turns before forced stop. | `24` |
| `--max-depth <n>` | Maximum sub-agent nesting depth. | `3` |
| `--skills <paths...>` | Skill files/directories (comma or space separated). | `.algorithme/skills` |
| `--plugins <paths...>` | Plugin directories (comma or space separated). | `.algorithme/plugins` |

### Interactive commands

| Command | Description |
| --- | --- |
| `/model <id>` | Switch provider/model mid-session. |
| `/clear` | Reset the conversation history. |
| `/status` | Show model, cwd, tools, skills, plugins, and session stats. |
| `/history` | Show the current conversation path with entry ids. |
| `/fork <n>` | Branch off from message #n (1-based, see `/history`). |
| `/lanes` | List branch leaves (id + depth); `*` marks the active one. |
| `/go <suffix>` | Move the cursor to a lane (e.g. `/go 12a4`). |
| `/skills` | List loaded skills. |
| `/help` | List commands. |
| `/exit`, `/quit` | Leave the agent. |

---

## Security & guardrails

The Algorithme AI Agent ships with a built-in security layer (`src/security/`) bound
into the agent pipeline as the first plugin (`algorithme-security`), plus direct
enforcement inside every tool.

- **Path sandboxing** — `read`, `write`, `edit`, `diff`, and `bash --cwd` resolve every
  path against the working directory and reject traversal (`..`) and symlink escapes.
  Extra roots can be whitelisted programmatically.
- **Command guard** — the `bash` tool refuses destructive or leaking commands:
  `rm -rf` on system paths, `mkfs`, block-device `dd`/redirects, fork bombs,
  `printenv`/bare `env`, reading `.env`/`.aws`/`.ssh`/`.git-credentials`/`/etc/shadow`,
  `curl | sh`, and `sudo`/`su`.
- **Secret masking** — `SecretManager` redacts API keys, tokens, and passwords from
  streaming deltas, tool results, session history, and compaction summaries before they
  reach the screen or the provider. Covers env-sourced secrets and common key shapes
  (`sk-…`, `Bearer …`, `AKIA…`, `ghp_…`, `xox…`, private key headers).
- **Hardened system prompt** — the default prompt instructs the agent to verify path
  safety, use tools deterministically, and never expose secrets.

These rules are enforced both by the tools themselves and by the
`algorithme-security` plugin (defense in depth), so any future tool is covered too.

---

## Termux (Android)

Run the agent natively on your Android device with [Termux](https://termux.com/):

```bash
# 1. Install Node.js and build tools
pkg update && pkg upgrade
pkg install nodejs-lts git

# 2. Clone and build
git clone https://github.com/zakmijo2-dotcom/Algorithmes-agent.git
cd Algorithmes-agent
npm install && npm run build

# 3. Optional: point at a local Ollama (or use a cloud key)
OLLAMA_BASE_URL=http://localhost:11434/v1

# 4. Run
npm start -- "what files import chalk?"
npm start                      # interactive
```

Notes:

- **Shell auto-detection** — the `bash` tool finds your Termux `bash` under `$PREFIX/bin/bash`
  automatically. Override with `ALGORITHME_SHELL` if needed (`PI_SHELL` still works).
- **Local inference** — install [Ollama for Android](https://ollama.com/download) and run
  models fully offline with `-m ollama:llama3`.
- **Terminal size** — small screens work best with `--max-turns 12` and terse prompts.
- Termux terminals support ANSI colors, so the full streaming UI (spinner, live tokens)
  works out of the box.

---

## Provider model ids

Model ids follow the `provider:model` pattern. A bare model string defaults to OpenRouter.

```bash
algorithme -m openrouter:deepseek/deepseek-r1 "summarize src/index.ts"
algorithme -m groq:llama-3.3-70b-versatile "write tests for src/tools"
algorithme -m ollama:llama3 "what files import chalk?"
```

| Provider | Env var | Notes |
| --- | --- | --- |
| `openrouter` | `OPENROUTER_API_KEY` | 400+ models behind one key |
| `groq` | `GROQ_API_KEY` | LPU-accelerated inference |
| `ollama` | `OLLAMA_API_KEY` (optional) | Fully local, offline |

---

## Architecture

```
src/
├── index.ts              CLI entry — arg parsing, banner, renderer, interactive/single-shot/piped modes
├── agent/
│   ├── prompt.ts         default system prompt + security guidelines
│   ├── loop.ts           deterministic turn loop, parallel tool execution, hook wiring, compaction
│   ├── session.ts        in-memory session tree: entries, lanes, fork/select, LLM compaction entries
│   └── subagent.ts       nested sub-agent tool (fresh context, bounded depth)
├── providers/            multi-provider abstraction
│   ├── base.ts           BaseProvider contract + shared OpenAI-compatible SSE client
│   ├── openrouter.ts     OpenRouter implementation
│   ├── groq.ts           Groq implementation
│   ├── ollama.ts         Ollama implementation
│   └── factory.ts        createProvider("provider:model") + parseModelId
├── tools/
│   ├── registry.ts       ToolRegistry, Tool/ToolContext contracts, ToolError
│   ├── read.ts           file/directory reader (offset/limit, numbered lines)
│   ├── write.ts          file writer (creates parent dirs)
│   ├── edit.ts           exact-string editor — fails on ambiguous matches, optional diff output
│   ├── diff.ts           line diff between files or against HEAD
│   └── bash.ts           sandboxed cwd-aware shell executor (120s timeout, command guard)
├── security/
│   ├── pathguard.ts      sandbox path resolution (lexical + symlink-aware)
│   ├── commands.ts       destructive / secret-leaking command detection
│   ├── secrets.ts        SecretManager — redaction of keys, tokens, passwords
│   ├── plugin.ts         algorithme-security beforeToolCall guardrail hook
│   └── index.ts          public exports
├── utils/
│   └── text.ts           diff (LCS), fuzzy matching, BOM/line-ending handling, truncation
├── skills/
│   ├── types.ts          Skill / SkillCommand / SkillHandler contracts
│   └── loader.ts         recursive loader — declarative (JSON/YAML) + module (TS/JS)
└── plugins/
    ├── hooks.ts          hook names, rich hook contexts, block/mutation result types
    └── manager.ts        lifecycle: load, setup, emitHook fan-out, before/after folding
```

### The agent loop

```
        ┌──────────────────────────────────────────────┐
        │  user input → system prompt + tools          │
        │              ↓                               │
        │  model stream (text + tool calls)            │
        │              ↓                               │
        │  execute tool calls (parallel)               │
        │              ↓                               │
        │  append tool output to history               │
        │              ↓                               │
        │  final answer? ── yes → return output        │
        │        no  ──→ loop (up to --max-turns)      │
        └──────────────────────────────────────────────┘
```

### Sub-agents

The agent exposes a `subagent` tool. When the model delegates, a **fresh** agent loop is spawned
with its own conversation, the same cwd, and (optionally) a different model. Nesting is
bounded (`--max-depth` default 3), so delegation can never recurse forever.

```
main agent ── subagent("research error handling in src/")
              └─ fresh context → read/grep → returns a focused summary
```

```bash
# The model decides when to delegate; no extra CLI flags required.
algorithme "Refactor the providers directory and write a short report on the changes."
```

### Provider layer

Every provider implements `BaseProvider.chat(messages, tools)` as an async iterator of
`text | tool | usage | end | error` events. OpenRouter, Groq, and Ollama are all
OpenAI-compatible, so they share one thin SSE parser and differ only in endpoint + auth.

---

## Extensibility

### Skills — add domain knowledge as agent tools

Skills live in `.algorithme/skills` (searched recursively). Every command becomes a tool named
`<skill>_<command>`.

**TypeScript skill with inline handler:**

```ts
// .algorithme/skills/greet.ts
export default {
  name: 'greet',
  description: 'Simple greeting skill',
  commands: {
    hello: {
      description: 'Say hello to someone',
      handler: (args) => `Hello, ${args.name ?? 'world'}!`,
    },
  },
};
```

**Declarative YAML skill with an external handler module:**

```yaml
# .algorithme/skills/math.yaml
name: math
description: Arithmetic helpers
commands:
  double:
    description: Double a number
    handlerFile: ./double.cjs   # module.exports = { handler: (args) => ... }
```

### Plugins — hook into the agent lifecycle

Plugins live in `.algorithme/plugins` and export a `Plugin` with an optional `setup()` and any of
the hooks: `onAgentStart`, `onTurnStart`, `beforeToolCall`, `afterToolCall`, `onCompaction`,
`onTurnEnd`.

- `beforeToolCall` receives `{ toolName, callId, args, cwd, depth }`. Return
  `{ block: true, reason, terminate? }` to prevent the tool from running — the loop feeds
  the block reason back to the model as an error result.
- `afterToolCall` receives `{ toolName, callId, args, result, isError, cwd, depth }`. Return
  a partial `{ content?, isError?, terminate? }` to mutate the executed result.

```ts
// .algorithme/plugins/guard.ts — block destructive commands and rewrite tool output
export default {
  name: 'guard',
  hooks: {
    onAgentStart: (ctx) => console.error(`[run] tools: ${ctx.tools.join(', ')}`),
    onTurnStart: (ctx) => console.error(`turn #${ctx.turn}`),
    beforeToolCall: (ctx) => {
      if (ctx.toolName === 'bash' && /rm -rf/.test(ctx.args.command ?? '')) {
        return { block: true, reason: 'refusing destructive rm -rf' };
      }
    },
    afterToolCall: (ctx) => {
      if (ctx.toolName === 'bash' && ctx.result.length > 2000) {
        return { content: `${ctx.result.slice(0, 2000)}\n… [truncated by plugin]` };
      }
    },
    onTurnEnd: (ctx) => console.error(`done: ${ctx.toolCalls} tool calls`),
  },
};
```

> The built-in `algorithme-security` plugin is attached automatically before any user
> plugins, so sandbox and command-guard rules always run first.

### Session tree — branching history

Instead of a flat message buffer, the agent keeps a tree of entries. Each user prompt,
assistant turn, and tool result is an immutable node with a `parentId`. Long histories are
summarized in place by the model into `compaction` entries that stand in for the dropped
messages (the pre-compaction subtree stays reachable as an alternate lane).

```
root ── user "fix the bug"
  ├── read a.ts → mutate → … ── assistant "done"        (lane 1, active)
  └── user "try a different approach" ── …               (lane 2, /fork)
```

- `/fork <n>` branches off from message #n of the current path.
- `/lanes` lists all leaves; `/go <suffix>` switches the cursor to another lane.
- Compaction runs automatically when the estimated context exceeds the budget
  (`--max-turns` does not affect it; disable with a `compaction: { enabled: false }`
  option when embedding `AgentLoop`).

---

## Design notes

- **Deterministic** — temperature defaults to `0`; each tool call executes exactly once and its result is appended verbatim as a `tool` message.
- **Self-correcting** — tool errors are returned to the model as readable traces, so it can diagnose and retry instead of stalling.
- **Compaction** — when the estimated context tokens exceed the budget, the oldest messages are summarized by the model into a `compaction` entry and recent turns are retained verbatim. Compaction never leaves a dangling tool result and always keeps the newest message.
- **Parallel tools** — multiple `tool_calls` in one turn execute concurrently.
- **Safe by default** — `edit` refuses ambiguous matches; `bash` is sandboxed and command-guarded with a timeout; file tools never leave the working directory.
- **Secrets never leak** — keys and tokens are masked before rendering to screen or history.

---

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # compile to dist/
npm run dev -- "..."  # run from source via tsx
```

---

## License

MIT

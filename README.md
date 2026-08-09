<div align="center">

# pi-agent

**A Pi-architected CLI AI coding agent — lightweight, deterministic, extensible.**

`pi-agent` is a production-grade terminal agent built on the design principles of the
[Pi](https://github.com/earendil-works/pi) coding-agent harness: a minimal agent loop,
zero bloat, deterministic tool calls, and a pluggable multi-provider + skills/plugins
architecture.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D18.17-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

</div>

---

## Highlights

- **Deterministic agent loop** — `user input → system prompt + tools → stream → execute tools → append results → repeat`, with tool failures fed back to the model for self-correction.
- **Multi-provider, one interface** — a single streaming contract (`BaseProvider.chat`) over **OpenRouter**, **Groq**, and local **Ollama**. Pick any provider + model with one string ID.
- **Zero-bloat core** — no vendor SDKs. Providers are thin SSE streams over the OpenAI-compatible API using native `fetch`.
- **Native file tools** — `read`, `write`, `edit`, `bash` — auto-registered, cwd-aware, safe by default.
- **Skills** — drop JSON/YAML/TS skill packs into `.pi/skills`; every command becomes an agent tool.
- **Plugins** — lifecycle hooks (`onTurnStart`, `beforeToolCall`, `afterToolCall`, `onTurnEnd`) loaded from `.pi/plugins`.
- **Streaming everywhere** — live token output in single-shot, interactive, and piped modes.

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
PI_MODEL=openrouter:deepseek/deepseek-r1
```

> No key? Point `OLLAMA_BASE_URL` at a running Ollama instance and use `ollama:llama3`.

### 3. Run it

```bash
# Single-shot: fix a bug, refactor a file, answer a question
npm run dev -- "fix the bug in src/agent/loop.ts"

# Interactive chat
npm run dev

# Compiled binary / global install
npm run build && npm start -- --help
npm install -g . && pi "explain this repo"
```

---

## CLI reference

```
Usage: pi [options] [prompt...]
```

| Option | Description | Default |
| --- | --- | --- |
| `[prompt...]` | Prompt for single-shot mode. Omit for interactive chat. | — |
| `-m, --model <id>` | Provider + model id, e.g. `groq:llama-3.3-70b-versatile`, `ollama:llama3`. | `$PI_MODEL` or `openrouter:deepseek/deepseek-r1` |
| `-c, --cwd <dir>` | Working directory the agent operates in. | `process.cwd()` |
| `-s, --system <text>` | Override the system prompt. | built-in |
| `-t, --temperature <n>` | Sampling temperature. | `0.0` |
| `--max-turns <n>` | Maximum agent-loop turns before forced stop. | `24` |
| `--skills <paths...>` | Skill files/directories (comma or space separated). | `.pi/skills` |
| `--plugins <paths...>` | Plugin directories (comma or space separated). | `.pi/plugins` |

### Interactive commands

| Command | Description |
| --- | --- |
| `/model <id>` | Switch provider/model mid-session. |
| `/clear` | Reset the conversation history. |
| `/status` | Show active model, tools, and plugins. |
| `/help` | List commands. |
| `/exit`, `/quit` | Leave the agent. |

---

## Provider model ids

Model ids follow the `provider:model` pattern. A bare model string defaults to OpenRouter.

```bash
pi -m openrouter:deepseek/deepseek-r1 "summarize src/index.ts"
pi -m groq:llama-3.3-70b-versatile "write tests for src/tools"
pi -m ollama:llama3 "what files import chalk?"
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
├── index.ts              CLI entry — arg parsing, interactive/single-shot/piped modes
├── agent/
│   ├── loop.ts           deterministic turn loop, parallel tool execution, error recovery
│   └── context.ts        rolling history + token-budget compaction
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
│   ├── edit.ts           exact-string editor — fails on ambiguous matches
│   └── bash.ts           cwd-aware shell executor (120s timeout, 10MB buffer)
├── skills/
│   ├── types.ts          Skill / SkillCommand / SkillHandler contracts
│   └── loader.ts         recursive loader — declarative (JSON/YAML) + module (TS/JS)
└── plugins/
    ├── hooks.ts          hook names + Plugin contract
    └── manager.ts        lifecycle: load, setup, emitHook fan-out
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

### Provider layer

Every provider implements `BaseProvider.chat(messages, tools)` as an async iterator of
`text | tool | usage | end | error` events. OpenRouter, Groq, and Ollama are all
OpenAI-compatible, so they share one thin SSE parser and differ only in endpoint + auth.

---

## Extensibility

### Skills — add domain knowledge as agent tools

Skills live in `.pi/skills` (searched recursively). Every command becomes a tool named
`<skill>_<command>`.

**TypeScript skill with inline handler:**

```ts
// .pi/skills/greet.ts
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
# .pi/skills/math.yaml
name: math
description: Arithmetic helpers
commands:
  double:
    description: Double a number
    handlerFile: ./double.cjs   # module.exports = { handler: (args) => ... }
```

### Plugins — hook into the agent lifecycle

Plugins live in `.pi/plugins` and export a `Plugin` with an optional `setup()` and any of
four hooks: `onTurnStart`, `beforeToolCall`, `afterToolCall`, `onTurnEnd`.

```ts
// .pi/plugins/logger.ts
export default {
  name: 'logger',
  hooks: {
    onTurnStart: (ctx) => console.error(`turn #${ctx.turn}`),
    beforeToolCall: (name, args) => console.error(`→ ${name}(${JSON.stringify(args)})`),
    afterToolCall: (name, result) => console.error(`← ${name} (${result.length} chars)`),
    onTurnEnd: (ctx) => console.error(`done: ${ctx.toolCalls} tool calls`),
  },
};
```

---

## Design notes

- **Deterministic** — temperature defaults to `0`; each tool call executes exactly once and its result is appended verbatim as a `tool` message.
- **Self-correcting** — tool errors are returned to the model as readable traces, so it can diagnose and retry instead of stalling.
- **Compaction** — history is trimmed oldest-first against a token budget, always cutting on a user/assistant boundary so tool results never dangle.
- **Parallel tools** — multiple `tool_calls` in one turn execute concurrently.
- **Safe by default** — `edit` refuses ambiguous matches; `bash` is cwd-aware with a timeout.

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

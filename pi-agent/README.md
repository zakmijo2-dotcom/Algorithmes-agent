# pi-agent

A production-grade, minimalist CLI AI coding agent built on the **Pi** architecture principles (by earendil-works/pi): a lightweight deterministic agent loop, zero bloat, native file tools, and an extensible multi-provider + skills/plugins harness.

## Features

- **Deterministic agent loop** — `user input → system prompt + tools → stream → execute tools → append results → repeat`, with tool errors fed back to the model for self-correction.
- **Multi-provider abstraction** — one streaming interface (`BaseProvider.chat`) over OpenRouter, Groq, and local Ollama. Provider + model selected by a single string ID.
- **Native tools** — `read`, `write`, `edit` (surgical diff), `bash`, auto-registered in a `ToolRegistry`.
- **Skills** — dynamic JSON / YAML / TS skills, loaded from `.pi/skills`, mapped to executable functions exposed as tools.
- **Plugins** — event hooks (`onTurnStart`, `beforeToolCall`, `afterToolCall`, `onTurnEnd`) loaded from `.pi/plugins`.
- **Zero bloat** — no SDKs; the provider client is a dependency-free SSE stream over the OpenAI-compatible API (`fetch`).

## Install & run

```bash
npm install
npm run dev -- "fix bug in app.ts"     # single-shot
npm run dev                            # interactive chat
npm run build && npm start -- --help   # compiled CLI
```

Environment (`.env` auto-loaded):

```bash
OPENROUTER_API_KEY=...          # openrouter provider
GROQ_API_KEY=...                # groq provider
OLLAMA_BASE_URL=http://localhost:11434/v1   # optional; local default
PI_MODEL=openrouter:deepseek/deepseek-r1    # default model id
```

## CLI

```
Usage: pi [options] [prompt...]

  -m, --model <id>        e.g. openrouter:deepseek/deepseek-r1, groq:llama-3.3-70b-versatile, ollama:llama3
  -c, --cwd <dir>         working directory (default: cwd)
  -s, --system <text>     custom system prompt
  -t, --temperature <n>   sampling temperature (default 0.0)
  --max-turns <n>         max agent loop turns (default 24)
  --skills <paths...>     skill files/directories (default: .pi/skills)
  --plugins <paths...>    plugin directories (default: .pi/plugins)
```

Interactive commands: `/model <id>`, `/clear`, `/status`, `/help`, `/exit`.

## Architecture

```
src/
├── index.ts              CLI entry (arg parsing, interactive + single-shot + piped modes)
├── agent/
│   ├── loop.ts           deterministic turn loop, parallel tool execution, error self-correction
│   └── context.ts        rolling history + token-budget compaction
├── providers/            multi-provider layer
│   ├── base.ts           BaseProvider interface + shared OpenAI-compatible SSE client
│   ├── openrouter.ts     OpenRouter implementation
│   ├── groq.ts           Groq implementation
│   ├── ollama.ts         Ollama implementation
│   └── factory.ts        createProvider("provider:model") + parseModelId
├── tools/
│   ├── registry.ts       ToolRegistry, Tool/ToolContext contracts, ToolError
│   ├── read.ts           native file/directory reader (offset/limit, line numbers)
│   ├── write.ts          native file writer (creates parents)
│   ├── edit.ts           exact-string surgical editor (fails on ambiguity)
│   └── bash.ts           shell executor (cwd-aware, 120s timeout)
├── skills/
│   ├── types.ts          Skill / SkillCommand / SkillHandler
│   └── loader.ts         recursive loader; declarative (JSON/YAML) + module (TS/JS) skills
└── plugins/
    ├── hooks.ts          hook names + plugin contracts
    └── manager.ts        lifecycle manager: load, setup, emitHook fan-out
```

### Providers

Every provider implements `BaseProvider.chat(messages, tools)` as an async iterator of
`text | tool | usage | end | error` events. OpenRouter, Groq and Ollama are all
OpenAI-compatible, so they share one thin SSE parser in `base.ts` and differ only in
endpoint + auth. The factory parses `provider:model` IDs; a bare model string defaults
to OpenRouter.

### Skills

Skills live in `.pi/skills` (recursive). Declarative JSON/YAML skills point each command
at a `handlerFile` module; TS/JS skills export a `Skill` object with inline handlers.
Every command becomes a tool named `<skill>_<command>`.

```ts
// .pi/skills/greet.ts
export default {
  name: 'greet',
  description: 'Simple greeting skill',
  commands: {
    hello: {
      description: 'Say hello',
      handler: (args) => `Hello, ${args.name}!`,
    },
  },
};
```

```yaml
# .pi/skills/math.yaml
name: math
description: Arithmetic helpers
commands:
  double:
    description: Double a number
    handlerFile: ./double.cjs   # module.exports = { handler: (args) => ... }
```

### Plugins

Plugins live in `.pi/plugins` and export a `Plugin` with optional `setup()` and hooks:

```ts
export default {
  name: 'logger',
  hooks: {
    onTurnStart: (ctx) => console.error(`turn #${ctx.turn}`),
    beforeToolCall: (name, args) => console.error(`→ ${name}`),
    afterToolCall: (name, result) => console.error(`← ${name}`),
    onTurnEnd: (ctx) => console.error(`${ctx.toolCalls} tool calls`),
  },
};
```

## Design notes

- **Deterministic**: temperature defaults to 0; tool calls execute exactly once, with
  results appended verbatim as `tool` messages.
- **Self-correcting**: tool failures are returned to the model as error text so it can
  retry with a corrected call.
- **Compaction**: history is trimmed oldest-first against a token budget, always starting
  on a user/assistant turn so no tool result dangles.
- **Parallel tools**: multiple `tool_calls` in one turn execute concurrently.

## License

MIT

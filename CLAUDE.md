# CLAUDE.md

Guidance for AI agents and contributors working in this repository.

## What this is

`pi-pipe` (the npm package / product name; the GitHub repo is `claude-pipe`) is a
local TypeScript bot that connects chat channels (Telegram, Discord, CLI) to a
configurable agent harness — the **Pi Coding Agent SDK** (default, multi-provider)
or the **Claude Agent SDK** (Anthropic only). Both implement one `ModelClient`
interface, so the rest of the app is harness-agnostic.

## Commands

```bash
npm install          # install deps (Node >= 20.18.1)
npm run dev          # run from source (tsx); first run launches onboarding
npm run build        # tsc -> dist/
npm run test:run     # run tests once (CI uses: npm run test:run -- --coverage)
npm run lint         # eslint
npm run format:check # prettier check (use `npm run format` to fix)
```

Before pushing, the same gate CI runs must pass locally:
`npx tsc --noEmit` · `npm run lint` · `npm run format:check` · `npm run test:run -- --coverage`.

## Architecture (single process)

```
channels (telegram/discord/cli) → MessageBus → AgentLoop → ModelClient (Pi | Claude) → SessionStore
```

- `src/index.ts` — boot: load config, wire bus/agent/channels/heartbeat/memory.
- `src/core/agent-loop.ts` — consumes inbound, runs one turn, parses response
  markers, publishes replies.
- `src/core/model-client.ts` — the harness-agnostic interface.
- `src/core/pi-client.ts` / `claude-client.ts` — the two harness implementations.
- `src/core/client-factory.ts` — selects the harness from `config.harness`.
- `src/core/markers.ts` — parses `[[file:…]]` / `[[keyboard:…]]` / `[[memory:…]]`.
- `src/core/guardrail.ts` — shared sandbox policy (blocks mutating tools +
  sensitive reads); applied to **both** harnesses when `config.sandbox` is true.
- `src/channels/*` — channel adapters implementing the `Channel` interface.
- `src/config/*` — zod schema, loader (`settings.json` + `PIPIPE_*` env overrides).

## Conventions

- **Strict TypeScript**, ESM (`NodeNext`). Prefer no `any` in `src/` (currently
  zero). `exactOptionalPropertyTypes` is on — include optional properties
  conditionally (`...(x ? { x } : {})`) rather than assigning `undefined`.
- **Tests are not typechecked** by `tsc` (the `include` is `src/**` only), so test
  configs are partial objects cast to `never`. New runtime code that reads a
  config field must read it defensively (optional chaining) so these partial
  configs don't break.
- Keep changes covered: vitest enforces coverage thresholds (see
  `vitest.config.ts`).
- Don't log secrets. Use the structured `logger`, not `console.*`, in runtime code.

## Security model

By default the agent has **full tool access** (read/write/bash) in the workspace —
this is the personal-assistant model. Set `sandbox: true` (settings.json or
`PIPIPE_SANDBOX=true`) to lock it down: mutating/exec tools and sensitive-path
reads are blocked on both harnesses. An empty `allowFrom` means the channel is
open to everyone — the bot warns about this at startup.

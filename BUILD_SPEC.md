# Pi Pipe Build Spec (v1)

- Status: Ready for implementation
- Date: 2026-02-08
- Source of truth: `/Users/mg/workspace/pi-pipe/PRD.md`

## 1. Goals

Build a local TypeScript bot for Telegram and Discord using the Pi Coding Agent SDK with per-channel session continuity. Inspired by the agent loop patterns from [openclaw/openclaw](https://github.com/openclaw/openclaw).

## 2. Locked Decisions

- Channels: Telegram + Discord.
- Trigger mode: reply to every message.
- Message type: text-only first.
- Session scope: per channel/chat (`channel:chat_id`).
- Persistence: session-file path map only.
- Workspace: configurable default path.
- Tool scope: Pi SDK built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`).
- Excluded: `spawn`, cron, heartbeat, media ingestion.
- Model: configurable string (default `claude-sonnet-4-5`); Pi resolves the provider.
- Runtime: local only.

## 3. Proposed Repository Layout

```text
pi-pipe/
  package.json
  tsconfig.json
  .env.example
  src/
    index.ts
    config/
      schema.ts
      load.ts
      settings.ts
    core/
      types.ts
      bus.ts
      logger.ts
      session-store.ts
      pi-client.ts
      model-client.ts
      client-factory.ts
      agent-loop.ts
      prompt-template.ts
      retry.ts
      text-chunk.ts
      transcript-logger.ts
    channels/
      base.ts
      telegram.ts
      discord.ts
      cli.ts
      manager.ts
  data/
    sessions.json
```

## 4. Runtime Flow

1. Channel adapter receives inbound text.
2. Adapter emits normalized `InboundMessage` to bus.
3. Agent loop consumes inbound event.
4. Agent loop resolves conversation key (`channel:chat_id`).
5. Session store returns existing Pi session-file path or none.
6. Pi client either reuses a cached `AgentSession`, opens one from disk (`SessionManager.open(filePath)`), or creates a fresh one (`SessionManager.create(workspace)`).
7. Pi client subscribes to `session.subscribe(...)` and calls `session.prompt(text)`.
8. Streaming events translate into agent-loop updates (`text_streaming`, `tool_call_started/finished/failed`).
9. Agent posts final text to outbound bus.
10. Channel adapter sends response to the same chat.
11. Pi client persists the session-file path on first creation so future restarts can resume.

## 5. Core Type Contracts

```ts
// src/core/types.ts
export type ChannelName = 'telegram' | 'discord' | 'cli'

export interface InboundMessage {
  channel: ChannelName
  senderId: string
  chatId: string
  content: string
  timestamp: string
  metadata?: Record<string, unknown>
}

export interface OutboundMessage {
  channel: ChannelName
  chatId: string
  content: string
  replyTo?: string
  metadata?: Record<string, unknown>
}

export interface SessionRecord {
  sessionFile: string
  updatedAt: string
}

export type SessionMap = Record<string, SessionRecord>
```

## 6. Config Contract

```ts
// src/config/schema.ts
export interface PiPipeConfig {
  model: string
  workspace: string
  channels: {
    telegram: { enabled: boolean; token: string; allowFrom: string[] }
    discord: { enabled: boolean; token: string; allowFrom: string[] }
    cli?: { enabled: boolean; allowFrom: string[] }
  }
  summaryPrompt: {
    enabled: boolean
    template: string
  }
  transcriptLog: {
    enabled: boolean
    path: string
    maxBytes?: number
    maxFiles?: number
  }
  sessionStorePath: string // default: ./data/sessions.json
  maxToolIterations: number // default: 20
}
```

Config source order:

1. `~/.pi-pipe/settings.json` (written by the onboarding wizard).
2. Environment overrides (`PIPIPE_*`).

## 7. Session Store Spec

- File: JSON object at `sessionStorePath`.
- Key: `channel:chatId`.
- Value: `{ sessionFile, updatedAt }`.
- Behavior:
  - load once at startup
  - atomic write on update (write temp + rename)
  - no transcript or user content storage

## 8. Pi Client Adapter Spec

Responsibilities:

- Maintain one `AgentSession` per `conversationKey` in memory.
- On first turn: `createAgentSession({ cwd, model, resourceLoader, sessionManager: SessionManager.create(cwd) })` and persist `session.sessionFile`.
- On cold start with a stored sessionFile: `SessionManager.open(filePath)` before `createAgentSession`.
- Register a Pi extension (`DefaultResourceLoader.extensionFactories`) that hooks `before_agent_start` and returns `{ systemPrompt }` carrying pi-pipe's communication-style + marker-protocol instructions.
- Subscribe to `session.subscribe(...)` events and translate them into channel-visible updates.
- On cancel: `await session.abort()`.

Pi SDK options used:

- `cwd`: workspace path
- `agentDir`: `getAgentDir()` (default `~/.pi/agent`)
- `model`: resolved via `ModelRegistry.find()` / `getModel()` from a config string
- `resourceLoader`: `DefaultResourceLoader` with all filesystem discovery disabled (`noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles`) plus pi-pipe's instructions extension
- `sessionManager`: `SessionManager.create(cwd)` or `SessionManager.open(filePath)`

## 9. Tools

pi-pipe uses Pi SDK's built-in tools by default — no `customTools` are passed in v1:

**File tools:** `read`, `write`, `edit`, `grep`, `find`, `ls`.

**Execution tools:** `bash`.

**Web tools:** none in v1 (can be added later via Pi extensions).

**Communication:** marker protocol parsed out of the model's text response (`[[file:…]]`, `[[keyboard:…]]`, `[[memory:…]]`) in `agent-loop.ts`. Future versions may replace markers with real Pi tools via an extension.

## 10. Channel Adapter Requirements

### Telegram

- Long polling implementation.
- Receive text messages and forward every inbound message.
- Outbound sends text to same chat id.
- Optional allow list check.

### Discord

- Gateway + REST send.
- Receive `MESSAGE_CREATE` and forward every inbound non-bot message.
- Outbound sends text to same channel id.
- Optional allow list check.

### CLI

- Stdin/stdout REPL for local testing.

## 11. Agent Loop Spec

Pseudo-flow:

```text
consume inbound
apply summary prompt template if enabled
ask PiClient.runTurn(conversationKey, text, ctx)
  - get-or-create AgentSession (cached / opened-from-file / freshly-created)
  - subscribe(event):
      - message_update text_delta → accumulate + emit text_streaming
      - tool_execution_start → emit tool_call_started
      - tool_execution_end → emit tool_call_finished | tool_call_failed
  - await session.prompt(text)
  - persist sessionFile if new
publish outbound final text
```

Controls:

- `maxToolIterations` default 20 (Pi handles tool looping internally).
- If no text after the turn: send fallback message.

## 12. Error Handling

- Channel receive errors: log + continue.
- Tool failure: surfaced via `tool_execution_end.isError`; reported to user.
- Pi prompt rejection (non-abort): surfaced as friendly error text.
- Session persistence failure: log error, continue current process.

## 13. Logging/Observability (local)

Structured logs with:

- timestamp
- channel
- conversation key
- event type (`inbound`, `pi.tool_call_started`, `pi.tool_call_finished`, `outbound`, `error`)
- duration metrics per turn

Do not log secrets or full file contents.

## 14. Security Posture (v1)

- Default Pi tool permissions are intentionally enabled by product decision.
- Clearly document this in README and `.env.example`.

## 15. Acceptance Test Matrix

1. Telegram workspace summary

- Send: "Summarize key files in the workspace"
- Expect: bot reads workspace files and returns summary in same Telegram chat.

2. Discord workspace summary

- Send equivalent prompt in Discord channel.
- Expect: summary response in same channel.

3. Session continuity

- Send follow-up: "Now summarize only the backend files"
- Restart process.
- Send follow-up reference question.
- Expect: continuity via resumed Pi session file.

4. Tool invocation

- Prompt requiring `ls` then `read`.
- Expect: tool calls execute and final answer reflects tool output.

5. Failure handling

- Force failing command via `bash`.
- Expect: graceful error surfaced to model and coherent final response.

## 16. Implementation Phases

1. Bootstrap project + config + logger + types.
2. Session store + Pi client wrapper.
3. Bus + agent loop.
4. Telegram + Discord + CLI adapters.
5. End-to-end local validation.

## 17. Definition of Done

- All acceptance tests above pass locally.
- PRD in `/Users/mg/workspace/pi-pipe/PRD.md` remains consistent with implementation.
- Build spec checkpoints are traceable in code modules.

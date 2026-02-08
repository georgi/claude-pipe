# Microclaw Build Spec (v1)

- Status: Ready for implementation
- Date: 2026-02-08
- Source of truth: `/Users/mg/workspace/microclaw/PRD.md`

## 1. Goals
Build a local TypeScript bot that reimplements nanobot core flows for Telegram and Discord using Claude Agent SDK V2 with per-channel session continuity.

## 2. Locked Decisions
- Channels: Telegram + Discord.
- Trigger mode: reply to every message.
- Message type: text-only first.
- Session scope: per channel/chat (`channel:chat_id`).
- Persistence: session id map only.
- Workspace: configurable default path.
- Tool scope: `read_file`, `write_file`, `edit_file`, `list_dir`, `exec`, `web_fetch`, `message`.
- Excluded: `spawn`, cron, heartbeat, media ingestion.
- Model: `claude-sonnet-4-5`.
- Runtime: local only.

## 3. Proposed Repository Layout

```text
microclaw/
  package.json
  tsconfig.json
  .env.example
  src/
    index.ts
    config/
      schema.ts
      load.ts
    core/
      types.ts
      bus.ts
      logger.ts
      session-store.ts
      claude-client.ts
      agent-loop.ts
    channels/
      base.ts
      telegram.ts
      discord.ts
      manager.ts
    tools/
      base.ts
      read-file.ts
      write-file.ts
      edit-file.ts
      list-dir.ts
      exec.ts
      web-fetch.ts
      message.ts
  data/
    sessions.json
```

## 4. Runtime Flow
1. Channel adapter receives inbound text.
2. Adapter emits normalized `InboundMessage` to bus.
3. Agent loop consumes inbound event.
4. Agent loop resolves conversation key (`channel:chat_id`).
5. Session store returns existing Claude session id or none.
6. Claude client resumes or creates session.
7. Agent sends user message (`session.send`).
8. Agent streams model events (`session.stream`) and executes tool calls when requested.
9. Agent posts final text to outbound bus.
10. Channel adapter sends response to the same chat.
11. Agent persists/updates conversation-to-session mapping.

## 5. Core Type Contracts

```ts
// src/core/types.ts
export type ChannelName = 'telegram' | 'discord'

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
  sessionId: string
  updatedAt: string
}

export type SessionMap = Record<string, SessionRecord>
```

## 6. Config Contract

```ts
// src/config/schema.ts
export interface MicroclawConfig {
  model: 'claude-sonnet-4-5'
  workspace: string
  channels: {
    telegram: { enabled: boolean; token: string; allowFrom: string[] }
    discord: { enabled: boolean; token: string; allowFrom: string[] }
  }
  tools: {
    execTimeoutSec: number
  }
  sessionStorePath: string // default: ./data/sessions.json
}
```

Config source order:
1. local config file (project-level)
2. environment overrides

## 7. Session Store Spec
- File: JSON object at `sessionStorePath`.
- Key: `channel:chatId`.
- Value: `{ sessionId, updatedAt }`.
- Behavior:
  - load once at startup
  - atomic write on update (write temp + rename)
  - no transcript or user content storage

## 8. Claude Client Adapter Spec
Responsibilities:
- Wrap SDK V2 preview API.
- `getOrCreateSession(conversationKey)`:
  - if mapping exists: `unstable_v2_resumeSession(sessionId, { model })`
  - else: `unstable_v2_createSession({ model })`
- Extract session id from streamed messages and persist mapping.
- Expose streamed assistant/tool events to agent loop.

Required compatibility note:
- Keep adapter boundary small because V2 API is unstable.

## 9. Tool Registry Spec
Interface:

```ts
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

export interface ToolContext {
  workspace: string
  channel: 'telegram' | 'discord'
  chatId: string
}
```

Rules:
- All tools return plain string results.
- Tool errors are returned as structured error strings, not thrown to crash loop.
- `message` tool publishes outbound messages and returns delivery status text.

## 10. Tool Behavior Requirements
- `read_file(path)`: UTF-8 read from workspace-related paths.
- `write_file(path, content)`: create parents, write UTF-8.
- `edit_file(path, old_text, new_text)`: single-target replace with ambiguity warning.
- `list_dir(path)`: directory listing.
- `exec(command, working_dir?)`: shell execution with timeout.
- `web_fetch(url, mode?, maxChars?)`: fetch and readable extraction.
- `message(content, channel?, chat_id?)`: send chat message using current context defaults.

## 11. Channel Adapter Requirements

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

## 12. Agent Loop Spec
Pseudo-flow:

```text
consume inbound
set tool context (channel/chat/workspace)
session = claudeClient.getOrCreateSession(conversationKey)
session.send(userText)
for event in session.stream():
  if event is tool call: execute tool, send tool result back to session
  if event is assistant text chunk/final: accumulate
publish outbound final text
persist session mapping
```

Controls:
- `maxToolIterations` default 20.
- If no final text after iterations: send fallback message.

## 13. Error Handling
- Channel receive errors: log + continue.
- Tool failure: return tool error string to model.
- Claude API failure: send user-friendly failure text.
- Session persistence failure: log error, continue current process.

## 14. Logging/Observability (local)
Structured logs with:
- timestamp
- channel
- conversation key
- event type (`inbound`, `tool_call`, `tool_result`, `outbound`, `error`)
- duration metrics per turn

Do not log secrets or full file contents.

## 15. Security Posture (v1)
- Full permissions are intentionally enabled by product decision.
- Clearly document this in README and `.env.example`.

## 16. Acceptance Test Matrix

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
- Expect: continuity via resumed Claude session.

4. Tool invocation
- Prompt requiring `list_dir` then `read_file`.
- Expect: tool calls execute and final answer reflects tool output.

5. Failure handling
- Force failing command via `exec`.
- Expect: graceful error surfaced to model and coherent final response.

## 17. Implementation Phases
1. Bootstrap project + config + logger + types.
2. Session store + Claude client wrapper.
3. Tool registry + core tools.
4. Bus + agent loop.
5. Telegram + Discord adapters.
6. End-to-end local validation.

## 18. Definition of Done
- All acceptance tests above pass locally.
- PRD in `/Users/mg/workspace/microclaw/PRD.md` remains consistent with implementation.
- Build spec checkpoints are traceable in code modules.

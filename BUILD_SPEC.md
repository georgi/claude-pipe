# Claude Pipe Build Spec (v1)

- Status: Ready for implementation
- Date: 2026-02-08
- Source of truth: `/Users/mg/workspace/claude-pipe/PRD.md`

## 1. Goals

Build a local TypeScript bot for Telegram and Discord using Claude Code CLI with per-channel session continuity. Inspired by the agent loop patterns from [openclaw/openclaw](https://github.com/openclaw/openclaw).

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
claude-pipe/
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
      prompt-template.ts
      retry.ts
      text-chunk.ts
      transcript-logger.ts
    channels/
      base.ts
      telegram.ts
      discord.ts
      manager.ts
  data/
    sessions.json
```

## 4. Runtime Flow

1. Channel adapter receives inbound text.
2. Adapter emits normalized `InboundMessage` to bus.
3. Agent loop consumes inbound event.
4. Agent loop resolves conversation key (`channel:chat_id`).
5. Session store returns existing Claude session id or none.
6. Claude client spawns CLI subprocess with `--resume <session_id>` if available.
7. CLI subprocess executes with `--print --output-format stream-json`.
8. Agent parses stream-json frames for assistant text, tool calls, and results.
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
export interface ClaudePipeConfig {
  model: string
  workspace: string
  channels: {
    telegram: { enabled: boolean; token: string; allowFrom: string[] }
    discord: { enabled: boolean; token: string; allowFrom: string[] }
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

- Spawn Claude Code CLI subprocess with `--print --output-format stream-json`.
- Pass `--resume <session_id>` if existing session mapping exists.
- Parse stdout line-by-line as stream-json frames.
- Extract session_id from result frames and persist mapping.
- Emit progress updates for tool call events (started/finished/failed).
- Return final assistant text response.

CLI flags used:

- `--print`: Output result to stdout
- `--verbose`: Enable detailed logging
- `--output-format stream-json`: Emit streaming JSON frames
- `--permission-mode bypassPermissions`: Full tool access
- `--dangerously-skip-permissions`: Skip permission prompts
- `--model <model>`: Specify model to use
- `--resume <session_id>`: Resume existing session

## 9. Tools

Claude Pipe uses Claude Code CLI's built-in tools. The CLI subprocess provides:

**File tools:**

- `read_file`: Read file contents
- `write_file`: Create or overwrite files
- `edit_file`: Edit existing files with search/replace
- `list_directory`: List directory contents

**Execution tools:**

- `run_command`: Execute shell commands

**Web tools:**

- `web_fetch`: Fetch and read web content
- `web_search`: Search the web (if configured)

**Communication:**

- `message`: Send messages back to channels (via ToolContext routing)

The CLI handles tool execution and result formatting. Claude Pipe focuses on:

- Spawning the CLI with proper workspace context
- Parsing tool call events from stream-json output
- Forwarding progress updates to channels
- Persisting session state across turns

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

## 11. Agent Loop Spec

Pseudo-flow:

```text
consume inbound
apply summary prompt template if enabled
spawn claude CLI subprocess with --resume if session exists
parse stream-json frames from stdout:
  - track tool_call_started events for progress
  - track tool_call_finished events for progress
  - accumulate assistant text blocks
  - extract session_id for persistence
publish outbound final text
persist session mapping
```

Controls:

- `maxToolIterations` default 20.
- If no final text after iterations: send fallback message.

## 12. Error Handling

- Channel receive errors: log + continue.
- Tool failure: return tool error string to model.
- Claude API failure: send user-friendly failure text.
- Session persistence failure: log error, continue current process.

## 13. Logging/Observability (local)

Structured logs with:

- timestamp
- channel
- conversation key
- event type (`inbound`, `tool_call`, `tool_result`, `outbound`, `error`)
- duration metrics per turn

Do not log secrets or full file contents.

## 14. Security Posture (v1)

- Full permissions are intentionally enabled by product decision.
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
- Expect: continuity via resumed Claude session.

4. Tool invocation

- Prompt requiring `list_dir` then `read_file`.
- Expect: tool calls execute and final answer reflects tool output.

5. Failure handling

- Force failing command via `exec`.
- Expect: graceful error surfaced to model and coherent final response.

## 16. Implementation Phases

1. Bootstrap project + config + logger + types.
2. Session store + Claude client wrapper.
3. Bus + agent loop.
4. Telegram + Discord adapters.
5. End-to-end local validation.

## 17. Definition of Done

- All acceptance tests above pass locally.
- PRD in `/Users/mg/workspace/claude-pipe/PRD.md` remains consistent with implementation.
- Build spec checkpoints are traceable in code modules.

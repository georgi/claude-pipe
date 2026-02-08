# microclaw

TypeScript reimplementation of nanobot core flows using Claude Agent SDK V2.

## Current State

This repository includes a working local runtime with:
- real Telegram inbound/outbound integration (Bot API long polling)
- real Discord inbound/outbound integration (`discord.js` gateway client)
- Claude SDK V2 multi-turn session handling with session resume persistence
- tool calling through an in-process MCP server backed by local TypeScript tools
- workspace boundary guardrails for file and shell tools
- outbound response chunking for Telegram and Discord limits
- channel send retry/backoff policy for transient failures
- configurable summary prompt templating for workspace-summary requests
- optional transcript logging toggle (off by default)
- size-based transcript rotation policy
- unit and acceptance-style tests

## Implemented vs Pending

| Area | Status | Notes |
|---|---|---|
| Config loading/validation | Implemented | `zod` schema + `.env` mapping |
| Session persistence | Implemented | JSON map: `conversation_key -> session_id` |
| Agent loop | Implemented | Inbound -> Claude turn -> outbound |
| Claude SDK V2 sessioning | Implemented | create/resume + streaming result handling |
| Tool calling | Implemented | MCP server generated from `ToolRegistry` |
| Telegram adapter | Implemented | Long polling + sendMessage + chunking + retry |
| Discord adapter | Implemented | Gateway message events + channel send + chunking + retry |
| Tool safety boundaries | Implemented | Workspace path guards + exec deny patterns |
| Summary prompt templating | Implemented | Request-aware template expansion |
| Transcript logging toggle | Implemented | Optional JSONL event stream |
| Transcript rotation | Implemented | Size-based file rotation with suffixes (`.1`, `.2`, ...) |
| Acceptance harness | Implemented | Telegram summary flow test |
| `spawn` subagents | Out of scope | Deferred by PRD |
| cron/heartbeat | Out of scope | Deferred by PRD |
| media ingestion | Out of scope | Text-only v1 |

## Architecture

```text
Telegram/Discord adapters
        |
        v
    MessageBus (inbound)
        |
        v
      AgentLoop
        |
        v
    ClaudeClient (SDK V2 session)
        |
        v
 MCP tool server (from ToolRegistry)
        |
        v
    local tool modules
        |
        v
    MessageBus (outbound)
        |
        v
Telegram/Discord send
```

## Runtime Contracts

### Conversation key
- Format: `channel:chat_id`
- Examples: `telegram:123456789`, `discord:1122334455`

### Session persistence
- File: `MICROCLAW_SESSION_STORE_PATH`
- Data shape:

```json
{
  "telegram:123456": {
    "sessionId": "...",
    "updatedAt": "2026-02-08T12:00:00.000Z"
  }
}
```

### Tool context per turn
Each tool executes with:
- `workspace`
- `channel`
- `chatId`

This allows the `message` tool to route back to the active conversation by default.

### Summary prompt templating
For summary-like requests (e.g., "summarize files in workspace"), `AgentLoop` can transform user input using a template before sending to Claude.

Template variables:
- `{{workspace}}`
- `{{request}}`

Config:
- `MICROCLAW_SUMMARY_PROMPT_ENABLED`
- `MICROCLAW_SUMMARY_PROMPT_TEMPLATE`

### Transcript logging and rotation (optional)
When enabled, runtime writes JSONL entries for user/assistant/system stream events.
- `MICROCLAW_TRANSCRIPT_LOG_ENABLED=true`
- `MICROCLAW_TRANSCRIPT_LOG_PATH=/absolute/path/to/transcript.jsonl`
- `MICROCLAW_TRANSCRIPT_LOG_MAX_BYTES=1000000`
- `MICROCLAW_TRANSCRIPT_LOG_MAX_FILES=3`

Rotation behavior:
- when current transcript exceeds `MAX_BYTES`, it rotates
- current file becomes `.1`, older `.1` becomes `.2`, etc.
- keeps up to `MAX_FILES` rotated files

Default transcript logging is disabled.

## Modules and Responsibilities

### `/Users/mg/workspace/microclaw/src/index.ts`
Bootstraps config, session store, tools, channel manager, and agent loop.

### `/Users/mg/workspace/microclaw/src/core/agent-loop.ts`
Main processing loop. Reads inbound events, executes one Claude turn, emits outbound response.
Includes `processOnce()` for deterministic integration/acceptance testing.
Applies summary prompt template for summary-like requests when enabled.

### `/Users/mg/workspace/microclaw/src/core/prompt-template.ts`
Summary prompt template application logic and request detection heuristics.

### `/Users/mg/workspace/microclaw/src/core/claude-client.ts`
Claude SDK V2 wrapper for:
- session create/resume
- per-conversation in-memory session cache
- stream parsing
- MCP tool server attachment
- optional transcript logging

### `/Users/mg/workspace/microclaw/src/core/transcript-logger.ts`
JSONL logger used when transcript logging is enabled.
Supports size-based rotation.

### `/Users/mg/workspace/microclaw/src/core/retry.ts`
Shared retry helper used by channel send paths for transient outbound failures.

### `/Users/mg/workspace/microclaw/src/core/mcp-server.ts`
Converts registered TypeScript tools into SDK MCP tools via `createSdkMcpServer`.

### `/Users/mg/workspace/microclaw/src/channels/telegram.ts`
Telegram Bot API polling loop (`getUpdates`) and outbound `sendMessage` with chunking and retry.

### `/Users/mg/workspace/microclaw/src/channels/discord.ts`
Discord gateway adapter via `discord.js`, consumes `messageCreate`, posts outbound channel messages with chunking and retry.

### `/Users/mg/workspace/microclaw/src/tools/*`
v1 tool implementations:
- `read_file`
- `write_file`
- `edit_file`
- `list_dir`
- `exec`
- `web_search`
- `web_fetch`
- `message`

Guardrails:
- File tools enforce workspace-bound paths.
- `exec` enforces workspace-bounded `working_dir` and deny-pattern command blocking.

## Test-First Workflow

Per your requirement, implementation follows this order for each task:
1. add or update tests first
2. implement or refactor code
3. run tests and build
4. commit the completed step

### Current tests
- `/Users/mg/workspace/microclaw/tests/bus.test.ts`
- `/Users/mg/workspace/microclaw/tests/session-store.test.ts`
- `/Users/mg/workspace/microclaw/tests/channel-base.test.ts`
- `/Users/mg/workspace/microclaw/tests/tool-registry.test.ts`
- `/Users/mg/workspace/microclaw/tests/agent-loop.test.ts`
- `/Users/mg/workspace/microclaw/tests/prompt-template.test.ts`
- `/Users/mg/workspace/microclaw/tests/telegram.test.ts`
- `/Users/mg/workspace/microclaw/tests/discord.test.ts`
- `/Users/mg/workspace/microclaw/tests/tool-safety.test.ts`
- `/Users/mg/workspace/microclaw/tests/exec-guard.test.ts`
- `/Users/mg/workspace/microclaw/tests/response-chunking.test.ts`
- `/Users/mg/workspace/microclaw/tests/channel-retry.test.ts`
- `/Users/mg/workspace/microclaw/tests/transcript-logger.test.ts`
- `/Users/mg/workspace/microclaw/tests/transcript-rotation.test.ts`
- `/Users/mg/workspace/microclaw/tests/config.test.ts`
- `/Users/mg/workspace/microclaw/tests/acceptance-telegram-summary.test.ts`

## Setup

1. Copy env template:
```bash
cp /Users/mg/workspace/microclaw/.env.example /Users/mg/workspace/microclaw/.env
```

2. Fill required values in `.env`:
- Telegram token and/or Discord token
- allow lists as needed
- workspace path
- optional Brave search key
- optional summary prompt template settings
- optional transcript logging + rotation settings

3. Install and validate:
```bash
cd /Users/mg/workspace/microclaw
npm install
npm run test:run
npm run build
```

4. Run:
```bash
npm run dev
```

## Operational Notes

- Channel adapters reply to every text message from allowed senders.
- If allow list is empty for a channel, all senders are allowed.
- Model is fixed to `claude-sonnet-4-5` per PRD decision.
- Permissions are configured to bypass checks in SDK session options, matching your v1 full-permission requirement.
- Outbound sends retry once (2 attempts total) with short fixed backoff.

## Known Limitations

- No media/file attachment ingestion yet.
- No cron/heartbeat orchestration.
- No subagent spawn behavior.
- Tool output formatting is intentionally plain text in v1.

## Next Implementation Targets

1. Add integration tests for Discord end-to-end summary flow.
2. Add optional channel-specific formatting profiles.
3. Add structured result modes for specific workflows (e.g., repo summary JSON).

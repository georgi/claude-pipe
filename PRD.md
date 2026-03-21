# Claude Pipe PRD (v1)

- Status: Approved for planning
- Date: 2026-02-08
- Owner: mg
- Implementation language: TypeScript
- LLM runtime: Claude Code CLI via subprocess (stream-json)

## 1. Product Summary

Claude Pipe is a local, single-user TypeScript bot for Telegram and Discord using Claude Code CLI subprocesses with stream-json output for session management. Inspired by the architecture and patterns from [openclaw/openclaw](https://github.com/openclaw/openclaw).

## 2. Objective

Deliver core agent behavior for:

- agent loop
- tool calling
- workspace management
- channels
- message handling

The first release focuses on reliable local operation and parity for core flows.

## 3. Primary User Story

As the bot owner, I send a Telegram message asking to summarize files in the workspace, and the bot reads workspace files and responds with a concise summary in the same channel.

## 4. Scope

### In Scope (v1)

- Telegram + Discord channel support.
- Reply to every inbound message.
- Text-only message handling.
- Per-channel conversation identity (`channel:chat_id`).
- Session persistence with only `conversation_key -> claude_session_id`.
- Configurable default workspace path.
- Full tool permissions for now.
- Local deployment/runtime only.
- Model locked to `claude-sonnet-4-5`.
- Tool set: Claude Code CLI built-in tools (file operations, shell execution, web tools)

### Out of Scope (v1)

- `spawn` subagents.
- cron/heartbeat features.
- media ingestion (voice/photo/document).
- multi-user or multi-tenant support.
- advanced compliance constraints.

## 5. Functional Requirements

1. Accept inbound messages from Telegram and Discord.
2. Normalize inbound events into one internal message format.
3. Resolve a conversation key per channel/chat.
4. Resume existing Claude session when available; otherwise create a new session.
5. Run the agent turn by spawning Claude Code CLI subprocess with stream-json output.
6. Parse tool call events and results from CLI output.
7. Send final text response to the same channel/chat.
8. Persist only the session mapping for future turns.

## 6. Non-Functional Requirements

- Local-first operation.
- Strong typing and modular boundaries.
- Idempotent handling where practical for message delivery retries.
- Structured logs suitable for local debugging.
- Minimal persisted user data (session map only).

## 7. Runtime/Platform Decisions

- Runtime: Node.js (local process).
- Deployment target: local machine only.
- No hard limits on latency/throughput/cost in v1.

## 8. High-Level Architecture

- `channels/`: Telegram and Discord adapters.
- `core/bus`: inbound/outbound event routing.
- `core/agent-loop`: orchestration loop.
- `core/claude-client`: CLI subprocess wrapper with stream-json parsing.
- `core/session-store`: persistent map of conversation key to session id.
- `core/transcript-logger`: optional JSONL event logging.
- `config/`: typed config loading and validation.

## 9. Data Model

`SessionMap` persisted to local JSON:

```json
{
  "telegram:123456": {
    "sessionId": "sess_abc",
    "updatedAt": "2026-02-08T12:00:00Z"
  }
}
```

Optional transcript logging to JSONL for debugging (disabled by default).

## 10. Risks

- Claude Code CLI subprocess behavior may change with updates.
- Tool-calling output format may require adapter updates during implementation.
- Full permissions increase operational risk by design (accepted for v1).

## 11. Success Criteria

- Telegram and Discord both respond to inbound text messages.
- Session continuity works across restarts through session map persistence.
- Workspace summarization scenario works end-to-end from Telegram.
- CLI tool calls are parsed correctly and progress updates flow to channels.

## 12. Milestones

1. Freeze interfaces and config schema.
2. Implement channel adapters and internal bus.
3. Implement Claude CLI client wrapper and agent loop.
4. Implement transcript logging and progress updates.
5. Validate with end-to-end local acceptance scenarios.

# Pi Pipe PRD (v1)

- Status: Approved for planning
- Date: 2026-02-08
- Owner: mg
- Implementation language: TypeScript
- LLM runtime: Pi Coding Agent SDK (`@earendil-works/pi-coding-agent`)

## 1. Product Summary

Pi Pipe is a local, single-user TypeScript bot for Telegram and Discord powered by the Pi Coding Agent SDK. Inspired by the architecture and patterns from [openclaw/openclaw](https://github.com/openclaw/openclaw).

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
- Session persistence with only `conversation_key -> pi_session_file`.
- Configurable default workspace path.
- Full tool permissions for now.
- Local deployment/runtime only.
- Model configurable (default `claude-sonnet-4-5` via Pi).
- Tool set: Pi SDK built-in tools (read, bash, edit, write, grep, find, ls)

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
4. Resume existing Pi session when one is stored; otherwise create a new session.
5. Run the agent turn by calling `session.prompt(text)` on a long-lived Pi `AgentSession`.
6. Translate Pi `session.subscribe` events (`message_update`, `tool_execution_*`) into channel-visible progress updates.
7. Send final text response to the same channel/chat.
8. Persist only the session-file mapping for future turns.

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
- `core/pi-client`: Pi SDK wrapper that owns a cached `AgentSession` per conversation, translates streaming events, and exposes the shared `ModelClient` interface.
- `core/session-store`: persistent map of conversation key to Pi session file path.
- `core/transcript-logger`: optional JSONL event logging.
- `config/`: typed config loading and validation.

## 9. Data Model

`SessionMap` persisted to local JSON:

```json
{
  "telegram:123456": {
    "sessionFile": "/Users/mg/workspace/.pi/sessions/sess_abc.jsonl",
    "updatedAt": "2026-02-08T12:00:00Z"
  }
}
```

Optional transcript logging to JSONL for debugging (disabled by default).

## 10. Risks

- Pi SDK behavior may change with updates; pin the package version.
- Streaming-event shapes may evolve (tool*execution*\* field names) and require translator updates.
- Full permissions increase operational risk by design (accepted for v1).

## 11. Success Criteria

- Telegram and Discord both respond to inbound text messages.
- Session continuity works across restarts through session file persistence.
- Workspace summarization scenario works end-to-end from Telegram.
- Tool calls are parsed correctly and progress updates flow to channels.

## 12. Milestones

1. Freeze interfaces and config schema.
2. Implement channel adapters and internal bus.
3. Implement Pi SDK client wrapper and agent loop.
4. Implement transcript logging and progress updates.
5. Validate with end-to-end local acceptance scenarios.

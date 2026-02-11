# Claude + Codex Protocol Handbook

This document captures practical protocol knowledge for building local agent integrations against:

- Claude Code CLI (`stream-json` over stdout)
- OpenAI Codex CLI App Server (`JSON-RPC 2.0` over stdin/stdout, newline-delimited JSON)

Use this as a portability reference for other projects.

## 1) Transport + Framing

### Claude Code CLI

- Process model: usually spawn-per-turn.
- Typical invocation:
  - `claude --print --verbose --output-format stream-json --permission-mode bypassPermissions ...`
- Input:
  - prompt passed as final CLI arg.
- Output:
  - newline-delimited JSON frames on `stdout`.
- Errors/logs:
  - non-JSON lines and diagnostics may appear on `stderr`.

### Codex CLI App Server

- Process model: long-lived JSON-RPC server over stdio.
- Invocation:
  - `codex app-server`
- Input framing:
  - one JSON-RPC message per line to `stdin`.
- Output framing:
  - one JSON-RPC message per line from `stdout`.
- You must classify each line as:
  - JSON-RPC response (`id` + `result` or `error`)
  - JSON-RPC notification (`method` without `id`)
  - JSON-RPC server request (`method` + `id`, requires response)

## 2) Conversation Lifecycle

### Claude lifecycle (stream-json)

1. Spawn process with optional `--resume <session_id>`.
2. Parse frames:
   - assistant content
   - tool-use blocks
   - tool-result blocks
   - result frame (`is_error`)
3. Persist observed `session_id`.
4. Exit process at turn end.

### Codex lifecycle (app-server)

1. `initialize`
2. `thread/start` (new) or `thread/resume` (existing)
3. `turn/start` with user input items
4. Consume notifications until `turn/completed`
5. Persist `thread.id` as conversation session key

## 3) Core Message Shapes

## Claude stream-json frames (high-level)

- `assistant`:
  - `message.content[]` with blocks:
    - `{ type: "text", text: string }`
    - `{ type: "tool_use", name: string, id?: string }`
- `user`:
  - may include `{ type: "tool_result", tool_use_id?: string, content?: unknown }`
- `result`:
  - includes completion/error signal (`is_error`) and final fallback text in some cases.
- Many frames may include `session_id`.

## Codex App Server JSON-RPC (v2 methods commonly used)

Client requests:

- `initialize`
- `thread/start`
- `thread/resume`
- `turn/start`
- optional: `model/list`

Server notifications (important):

- `thread/started`
- `turn/started`
- `item/started`
- `item/completed`
- `item/agentMessage/delta` (token streaming)
- `item/commandExecution/outputDelta`
- `item/mcpToolCall/progress`
- `turn/completed`
- `error`

Server requests requiring client responses:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/tool/requestUserInput`

## 4) Session/Thread Mapping Strategy

- Maintain one persisted mapping per conversation key:
  - `conversation_key -> sessionId` (Claude `session_id` or Codex `thread.id`)
- Resume behavior:
  - Claude: pass `--resume <session_id>`
  - Codex: call `thread/resume { threadId }`
- Reset behavior:
  - clear mapping to force fresh session/thread next turn

## 5) Streaming Semantics

### Claude

- Collect assistant text blocks into final response text.
- Emit tool status based on tool use/result block pairs.
- `result.is_error === true` should mark turn failed.

### Codex

- Accumulate user-visible answer from `item/agentMessage/delta.params.delta`.
- Tool telemetry can be derived from `item/started`/`item/completed`:
  - `item.type` often one of:
    - `commandExecution`
    - `fileChange`
    - `mcpToolCall`
    - `webSearch`
- Turn terminal signal:
  - `turn/completed` with `turn.status` and optional `turn.error`.

## 6) Approval Handshake (Codex)

When server asks approval (JSON-RPC server request), you must reply using the same `id`.

Examples:

- `item/commandExecution/requestApproval` -> `{ decision: "accept" | "decline" | ... }`
- `item/fileChange/requestApproval` -> `{ decision: "accept" | "decline" | ... }`
- `item/tool/requestUserInput` -> `{ answers: { [questionId]: { answers: string[] } } }`

If you do not respond, the turn can stall.

## 7) Workspace Context Injection

Portable pattern:

- Set CWD at thread/turn level where protocol supports it.
- Also include explicit workspace in user prompt preamble:
  - `Workspace: /path/...`

Recommended for consistency across providers and when tools depend on prompt context.

## 8) Error Model Differences

### Claude

- Failures can be indicated by:
  - process exit code/signal
  - parse failures
  - result frame with error flag

### Codex

- Failures may arrive as:
  - JSON-RPC response error (`{ error: { code, message } }`)
  - notification `error`
  - `turn/completed` with failed status
  - process-level failures (spawn/exit/signal)

Treat all as first-class and unify into one turn-failed path.

## 9) Auth + Runtime Notes

### Claude

- Auth/session generally managed by Claude CLI installation/login state.

### Codex

- Uses local account session and/or API key environment setup.
- Common environment wiring:
  - `OPENAI_API_KEY` (or project-specific alias mapped to it)
- Do not hardcode auth assumptions; surface clear setup errors.

## 10) Minimal Cross-Provider Adapter Interface

Use a common interface:

- `runTurn(conversationKey, prompt, context) -> Promise<string>`
- `startNewSession(conversationKey)`
- `closeAll()`

This isolates protocol differences from your agent loop/channels.

## 11) Implementation Checklist

1. NDJSON line buffer parser (handles partial chunks).
2. Message classification (response/notification/server request).
3. Pending-request map by JSON-RPC id (Codex).
4. Tool/status event mapper into UI/channel updates.
5. Session/thread persistence.
6. Robust process lifecycle handling:
   - spawn error
   - close event
   - stderr collection/logging
7. Guardrails:
   - unknown methods tolerated (log + continue)
   - malformed frames handled without crashing loop

## 12) Testing Strategy

Unit tests:

- framing parser for split/chunked lines
- message classifier
- approval response payload generation
- session mapping logic

Integration tests:

- fake subprocess server that emits realistic sequence:
  - initialize response
  - thread start/resume response
  - turn notifications
  - tool item start/completion
  - final turn completion
- assert final text, tool events, and persisted session/thread id

## 13) Known Versioning Realities

- Codex protocol includes older + newer method families (legacy and v2-style names).
- Prefer v2-style methods used by current app-server bindings:
  - `thread/*`, `turn/*`, `model/list`, `item/*`
- Keep protocol constants centralized so updates are localized.

## 14) Practical Mapping Table (Claude -> Codex)

- Create session -> `thread/start`
- Resume session -> `thread/resume`
- Start turn/message send -> `turn/start`
- Token stream -> `item/agentMessage/delta`
- Tool start/finish -> `item/started` / `item/completed`
- Diff/apply patch approval -> `item/fileChange/requestApproval`
- Command approval -> `item/commandExecution/requestApproval`

## 15) Recommended Operational Defaults

- Keep one long-lived Codex app-server process per conversation worker OR one per turn (simpler but less efficient).
- Use conservative approval defaults in automated modes.
- Capture and cap raw line logging to avoid log bloat.
- Persist transcript/events for reproducible debugging.


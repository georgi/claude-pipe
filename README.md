# pi-pipe

Pi Pipe is a personal AI assistant you run on your own machine. It answers you on the channels you already use (Telegram, Discord) or your terminal. It runs on a configurable **agent harness** — either the [Pi Coding Agent SDK](https://pi.dev/docs/latest/sdk) (multi-provider; default) or the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) (Anthropic models). Both expose the same chat behavior, so you can switch with one setting.

Inspired by [openclaw/openclaw](https://github.com/openclaw/openclaw).

## What it does

Pi Pipe connects your chat apps (or terminal) to a Pi coding agent. When you send a message, it:

1. Picks up your message
2. Passes it to Pi (with access to your workspace)
3. Sends the response back to the chat

Pi remembers previous messages in the conversation, so you can have ongoing back-and-forth sessions. It can read and edit files, run shell commands, search the web, and use any extensions you have configured — all the things Pi normally does, triggered from your chat app.

## Getting started

You'll need [Node.js](https://nodejs.org/) 20.18.1+ (required by the Pi SDK's transitive `undici@7` dependency) and an `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` exported in your environment (the Pi SDK reads them automatically).

**1. Clone and install**

```bash
git clone https://github.com/georgi/claude-pipe.git pi-pipe
cd pi-pipe
npm install
```

**2. Run the onboarding wizard**

```bash
npm run dev
```

First run starts the interactive setup wizard:

1. **Choose platform** — select Telegram, Discord, or CLI (local terminal)
2. **Enter bot token** — required for Telegram/Discord, skipped in CLI mode
3. **Choose agent harness** — Pi Coding Agent SDK (multi-provider) or Claude Agent SDK (Anthropic only)
4. **Select model** — preset list (Claude, GPT-5, …) or free-form entry (supports `provider/model-id`)
5. **Set workspace** — directory the agent can access (defaults to current directory)
6. **Set personality** — give your assistant a name and description

Settings are saved to `~/.pi-pipe/settings.json`.

**3. Start the bot**

After setup, the bot starts automatically. To restart it later:

```bash
npm run dev     # development mode (TypeScript with tsx)
npm start       # production mode (runs compiled JavaScript)
```

**Reconfigure settings**

```bash
npm run dev -- --reconfigure    # or -r
npm run dev -- --help           # or -h
```

**Start chatting**

Send a message to your bot (or type in terminal if using CLI mode) and Pi will reply.

## Architecture

Pi Pipe is a single Node.js process. One event bus, pluggable channels, one agent loop.

```
┌─────────┐  ┌─────────┐  ┌─────────┐
│Telegram │  │ Discord │  │   CLI   │
└────┬────┘  └────┬────┘  └────┬────┘
     │            │            │
     ▼            ▼            ▼
┌──────────────────────────────────────┐
│            Message Bus               │
│       (inbound / outbound queues)    │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│            Agent Loop                │
│  ┌─────────────┐  ┌──────────────┐  │
│  │  Command    │  │   PiClient   │  │
│  │  Handler    │  │  (Pi SDK     │  │
│  │  (/session, │  │   AgentSess) │  │
│  │   /model..) │  └──────┬───────┘  │
│  └─────────────┘         │          │
└──────────────────────────┼──────────┘
                           │
                  ┌────────▼────────┐
                  │  Session Store  │
                  │  (JSON file)    │
                  └─────────────────┘
```

### Single Process

One Node.js process runs the event bus, agent loop, and all channel adapters. No microservices, no message brokers.

### Message Bus

Channels and the agent loop are decoupled through async inbound/outbound queues. Channels publish inbound messages; the agent loop consumes them, runs a turn, and publishes replies that the channel manager dispatches back.

### Pi SDK

Each conversation owns a long-lived `AgentSession` from `@earendil-works/pi-coding-agent`. The PiClient calls `session.prompt(text)` per turn and translates `session.subscribe(...)` events (`message_update` / `tool_execution_start` / `tool_execution_end`) into the agent loop's internal update kinds. Sessions persist to disk as Pi session files; their paths are recorded so conversations resume across restarts via `SessionManager.open(filePath)`. Cancellation uses `session.abort()`.

### Pluggable Channels

Each channel (Telegram, Discord, CLI) implements the same adapter interface: `start`, `stop`, `send`, `editMessage`. The channel manager owns their lifecycle and routes outbound messages to the right adapter.

### Command Interception

Slash commands (`/session`, `/model`, `/config`, etc.) are intercepted before reaching the LLM, so they execute instantly without spending tokens.

### Streaming Updates

During a turn, tool call progress is shown as editable status messages (🔧 → ✅ / ❌). Streaming text replaces the status with the final response.

### Pi instructions extension

pi-pipe's house instructions (concise communication style, attachment / inline-keyboard / memory marker protocols, plus your personality) are contributed to the agent through a Pi extension registered on the `DefaultResourceLoader`. The extension hooks `before_agent_start` and appends its content to the chained system prompt. Pi's normal discovery still runs alongside — your workspace `AGENTS.md`, extensions installed in `~/.pi/agent/extensions/`, and skills in `~/.pi/agent/skills/` all load as usual.

### Key Files

| File                        | Role                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| `src/index.ts`              | Boots the runtime — config, bus, agent, channels, heartbeat          |
| `src/core/agent-loop.ts`    | Consumes inbound messages, runs LLM turns, publishes replies         |
| `src/core/pi-client.ts`     | Wraps the Pi SDK AgentSession, handles streaming and session caching |
| `src/core/bus.ts`           | Async message bus with inbound/outbound queues                       |
| `src/channels/manager.ts`   | Owns channel lifecycle and outbound dispatch                         |
| `src/core/session-store.ts` | Persists session-file paths to a JSON file for cross-restart resume  |
| `src/commands/handler.ts`   | Slash command interception and execution                             |
| `src/config/load.ts`        | Loads and validates settings from `~/.pi-pipe/settings.json`         |

## Configuration reference

Configuration is stored in `~/.pi-pipe/settings.json` and created by the onboarding wizard.

```json
{
  "channel": "telegram",
  "token": "your-bot-token",
  "allowFrom": ["user-id-1", "user-id-2"],
  "harness": "pi",
  "model": "claude-sonnet-4-5",
  "workspace": "/path/to/your/workspace",
  "personality": {
    "name": "Piper",
    "traits": "friendly, direct, and concise"
  }
}
```

| Setting         | What it does                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `channel`       | Platform to use: `telegram`, `discord`, or `cli`                                                                                                       |
| `token`         | Bot token from [BotFather](https://t.me/botfather) or [Discord Developer Portal](https://discord.com/developers/applications)                          |
| `allowFrom`     | Array of allowed user IDs (empty = allow everyone)                                                                                                     |
| `allowChannels` | Discord-only: channel ID allowlist (empty/missing = allow all channels)                                                                                |
| `harness`       | Agent harness: `pi` (Pi Coding Agent SDK, multi-provider; default) or `claude` (Claude Agent SDK, Anthropic only)                                      |
| `sandbox`       | When `true`, lock the agent into a restricted sandbox (no shell/edit/write, no sensitive-path reads) on both harnesses. Default `false` (full access). |
| `model`         | Model name (e.g. `claude-sonnet-4-5`, `gpt-5`, `kimi-k2`, or `provider/model-id`; non-Anthropic ids require the `pi` harness)                          |
| `workspace`     | Root directory the agent can access                                                                                                                    |
| `personality`   | Optional: give your assistant a `name` and `traits` description                                                                                        |
| `env`           | Optional: environment variables to inject at startup                                                                                                   |

### Authentication

The active harness reads provider credentials from the environment:

- `ANTHROPIC_API_KEY` — required for Claude models (and for the entire `claude` harness)
- `OPENAI_API_KEY` — required for GPT / OpenAI models (Pi harness)
- Other providers (Pi harness): see the [Pi providers docs](https://pi.dev/docs/latest/providers)

The `claude` harness only supports Anthropic models; use the `pi` harness for any other provider.

Set them in your shell profile or in `~/.pi-pipe/.env`.

### Advanced configuration via environment variables

For options not in the settings file, use a `.env` file in `~/.pi-pipe/` or the project root.

| Variable                          | What it does                                                               |
| --------------------------------- | -------------------------------------------------------------------------- |
| `PIPIPE_HARNESS`                  | Agent harness: `pi` (default) or `claude` (overrides the settings value)   |
| `PIPIPE_SANDBOX`                  | `true`/`false` — restrict tools to a read-only sandbox (default `false`)   |
| `PIPIPE_SESSION_STORE_PATH`       | Where to save session data (default: `{workspace}/data/sessions.json`)     |
| `PIPIPE_MAX_TOOL_ITERATIONS`      | Max tool calls per turn (default: 20)                                      |
| `PIPIPE_SUMMARY_PROMPT_ENABLED`   | Enable summary prompt templates                                            |
| `PIPIPE_SUMMARY_PROMPT_TEMPLATE`  | Template for summary requests (supports `{{workspace}}` and `{{request}}`) |
| `PIPIPE_TRANSCRIPT_LOG_ENABLED`   | Log conversations to a file                                                |
| `PIPIPE_TRANSCRIPT_LOG_PATH`      | Path for transcript log file                                               |
| `PIPIPE_TRANSCRIPT_LOG_MAX_BYTES` | Max transcript file size before rotation                                   |
| `PIPIPE_TRANSCRIPT_LOG_MAX_FILES` | Number of rotated transcript files to keep                                 |
| `PIPIPE_CLI_ENABLED`              | Enable CLI channel (`true`/`false`)                                        |
| `PIPIPE_DISCORD_ALLOW_CHANNELS`   | Comma-separated allowed Discord channel IDs (empty = allow all)            |
| `PIPIPE_CLI_ALLOW_FROM`           | Comma-separated allowed sender IDs for CLI mode                            |

### Permissions

By default the agent runs with full tool access (read, bash, edit, write, …) on
both harnesses — it can read/write files and run shell commands in the workspace.
Make sure your workspace is a directory you're comfortable giving full access to.

**Sandbox mode.** Set `sandbox: true` in `settings.json` (or `PIPIPE_SANDBOX=true`)
to lock the agent down: shell execution and file edits/writes are blocked, and
reads of sensitive paths (`~/.ssh`, `~/.env`, `~/.aws`, `/etc/passwd`, the
`pi-pipe` config dir, …) are denied. This applies to **both** the Pi and Claude
harnesses, and is recommended for any public or shared deployment.

**Access control.** `allowFrom` restricts who can talk to the bot. An empty
`allowFrom` allows everyone — the bot logs a warning at startup when a
network-facing channel runs wide open. Inbound messages are also rate-limited
per sender (see `rateLimit`).

## Development

```bash
npm run build    # compile TypeScript to dist/
npm run test     # run tests in watch mode
npm run test:run # run tests once
```

## Features

- **Multi-channel support**: Works with Telegram, Discord, and CLI
- **Bidirectional media attachments**: Full support for sending and receiving images, videos, documents, and audio files
  - Receive attachments from users via Telegram and Discord
  - Send attachments back to users in agent responses
  - Images and files are described to the agent with their locations
  - The agent can reference attached files in its workspace
- **Voice transcription**: Voice messages in Telegram are automatically transcribed using whisper-cpp
- **Session continuity**: Conversations persist across restarts with saved Pi session files
- **Workspace access**: The agent can read/edit files, run commands, and search the web within your configured workspace

## Current limitations

- Runs locally, not designed for server deployment
- Conversations are processed one at a time (a long-running turn blocks others)

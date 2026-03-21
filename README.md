# claude-pipe

Claude Pipe is a personal AI assistant you run on your own machine. It answers you on the channels you already use (Telegram, Discord) or your terminal. It connects directly to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via the official [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript).

Inspired by [openclaw/openclaw](https://github.com/openclaw/openclaw).

## What it does

Claude Pipe connects your chat apps (or terminal) to Claude Code. When you send a message, it:

1. Picks up your message
2. Passes it to Claude (with access to your workspace)
3. Sends the response back to the chat

Claude remembers previous messages in the conversation, so you can have ongoing back-and-forth sessions. It can read and edit files, run shell commands, search the web, and use any MCP tools you have configured — all the things Claude Code normally does, triggered from your chat app.

## Getting started

You'll need [Node.js](https://nodejs.org/) 20+ and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and logged in.

**1. Clone and install**

```bash
git clone https://github.com/georgi/claude-pipe.git
cd claude-pipe
npm install
```

**2. Run the onboarding wizard**

```bash
npm run dev
```

First run starts the interactive setup wizard:

1. **Choose platform** — select Telegram, Discord, or CLI (local terminal)
2. **Enter bot token** — required for Telegram/Discord, skipped in CLI mode
3. **Select model** — preset list or free-form entry
4. **Set workspace** — directory Claude can access (defaults to current directory)
5. **Set personality** — give your assistant a name and description

Settings are saved to `~/.claude-pipe/settings.json`.

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

Send a message to your bot (or type in terminal if using CLI mode) and Claude will reply.

## Architecture

Claude Pipe is a single Node.js process. One event bus, pluggable channels, one agent loop.

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
│  │  Command     │  │ ClaudeClient │  │
│  │  Handler     │  │ (Agent SDK   │  │
│  │  (/session,  │  │  query())    │  │
│  │   /model..)  │  └──────┬───────┘  │
│  └─────────────┘          │          │
└───────────────────────────┼──────────┘
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

### Agent SDK

Each turn calls `query()` from `@anthropic-ai/claude-agent-sdk` — an async generator that yields typed message frames. Sessions are resumed across turns via `session_id`. Cancellation uses `AbortController`.

### Pluggable Channels

Each channel (Telegram, Discord, CLI) implements the same adapter interface: `start`, `stop`, `send`, `editMessage`. The channel manager owns their lifecycle and routes outbound messages to the right adapter.

### Command Interception

Slash commands (`/session`, `/model`, `/config`, etc.) are intercepted before reaching the LLM, so they execute instantly without spending tokens.

### Streaming Updates

During a turn, tool call progress is shown as editable status messages (🔧 → ✅ / ❌). Streaming text replaces the status with the final response.

### Key Files

| File | Role |
|---|---|
| `src/index.ts` | Boots the runtime — config, bus, agent, channels, heartbeat |
| `src/core/agent-loop.ts` | Consumes inbound messages, runs LLM turns, publishes replies |
| `src/core/claude-client.ts` | Wraps Agent SDK `query()`, handles streaming and session persistence |
| `src/core/bus.ts` | Async message bus with inbound/outbound queues |
| `src/channels/manager.ts` | Owns channel lifecycle and outbound dispatch |
| `src/core/session-store.ts` | Persists conversation sessions to a JSON file |
| `src/commands/handler.ts` | Slash command interception and execution |
| `src/config/load.ts` | Loads and validates settings from `~/.claude-pipe/settings.json` |

## Configuration reference

Configuration is stored in `~/.claude-pipe/settings.json` and created by the onboarding wizard.

```json
{
  "channel": "telegram",
  "token": "your-bot-token",
  "allowFrom": ["user-id-1", "user-id-2"],
  "model": "claude-sonnet-4-5",
  "workspace": "/path/to/your/workspace",
  "personality": {
    "name": "Piper",
    "traits": "friendly, direct, and concise"
  }
}
```

| Setting | What it does |
|---|---|
| `channel` | Platform to use: `telegram`, `discord`, or `cli` |
| `token` | Bot token from [BotFather](https://t.me/botfather) or [Discord Developer Portal](https://discord.com/developers/applications) |
| `allowFrom` | Array of allowed user IDs (empty = allow everyone) |
| `allowChannels` | Discord-only: channel ID allowlist (empty/missing = allow all channels) |
| `model` | Claude model (e.g. `claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-opus-4-5`) |
| `workspace` | Root directory Claude can access |
| `personality` | Optional: give your assistant a `name` and `traits` description |
| `env` | Optional: environment variables to inject at startup |

### Advanced configuration via environment variables

For options not in the settings file, use a `.env` file in `~/.claude-pipe/` or the project root.

| Variable | What it does |
|---|---|
| `CLAUDEPIPE_SESSION_STORE_PATH` | Where to save session data (default: `{workspace}/data/sessions.json`) |
| `CLAUDEPIPE_MAX_TOOL_ITERATIONS` | Max tool calls per turn (default: 20) |
| `CLAUDEPIPE_SUMMARY_PROMPT_ENABLED` | Enable summary prompt templates |
| `CLAUDEPIPE_SUMMARY_PROMPT_TEMPLATE` | Template for summary requests (supports `{{workspace}}` and `{{request}}`) |
| `CLAUDEPIPE_TRANSCRIPT_LOG_ENABLED` | Log conversations to a file |
| `CLAUDEPIPE_TRANSCRIPT_LOG_PATH` | Path for transcript log file |
| `CLAUDEPIPE_TRANSCRIPT_LOG_MAX_BYTES` | Max transcript file size before rotation |
| `CLAUDEPIPE_TRANSCRIPT_LOG_MAX_FILES` | Number of rotated transcript files to keep |
| `CLAUDEPIPE_CLI_ENABLED` | Enable CLI channel (`true`/`false`) |
| `CLAUDEPIPE_DISCORD_ALLOW_CHANNELS` | Comma-separated allowed Discord channel IDs (empty = allow all) |
| `CLAUDEPIPE_CLI_ALLOW_FROM` | Comma-separated allowed sender IDs for CLI mode |

### Permissions

Claude runs with `bypassPermissions` — it can read/write files and run shell commands in the workspace without prompting. Make sure your workspace is a directory you're comfortable giving full access to.

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
- **Session continuity**: Conversations persist across restarts with saved session state
- **Workspace access**: The agent can read/edit files, run commands, and search the web within your configured workspace

## Current limitations

- Runs locally, not designed for server deployment
- No scheduled or background tasks

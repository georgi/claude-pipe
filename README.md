# pi-pipe

Pi Pipe is a personal AI assistant you run on your own machine. It answers you on the channels you already use (Telegram, Discord) or your terminal. It runs on a configurable **agent harness** — the [Pi Coding Agent SDK](https://pi.dev/docs/latest/sdk) (multi-provider; default), the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) (Anthropic models), or the [OpenAI Codex SDK](https://developers.openai.com/codex/sdk/) (OpenAI models). All three expose the same chat behavior, so you can switch with one setting.

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
3. **Choose agent harness** — Pi Coding Agent SDK (multi-provider), Claude Agent SDK (Anthropic only), or OpenAI Codex SDK (OpenAI only)
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

| Setting         | What it does                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channel`       | Platform to use: `telegram`, `discord`, or `cli`                                                                                                            |
| `token`         | Bot token from [BotFather](https://t.me/botfather) or [Discord Developer Portal](https://discord.com/developers/applications)                               |
| `allowFrom`     | Array of allowed user IDs (empty = allow everyone)                                                                                                          |
| `allowChannels` | Discord-only: channel ID allowlist (empty/missing = allow all channels); thread messages match their parent channel too                                     |
| `harness`       | Agent harness: `pi` (Pi Coding Agent SDK, multi-provider; default), `claude` (Claude Agent SDK, Anthropic only), or `codex` (OpenAI Codex SDK, OpenAI only) |
| `model`         | Model name (e.g. `claude-opus-5`, `gpt-5.1-codex`, `kimi-k2`, or `provider/model-id`; the `provider/model-id` form requires the `pi` harness)               |
| `workspace`     | Root directory the agent can access                                                                                                                         |
| `personality`   | Optional: give your assistant a `name` and `traits` description                                                                                             |
| `env`           | Optional: environment variables to inject at startup                                                                                                        |

> **Switching harnesses starts a new conversation.** Each harness mints its own
> kind of session reference, and a session id from one is meaningless to another,
> so a stored session is only resumed by the harness that created it. Changing
> `harness` therefore begins a fresh conversation rather than resuming the old one.

> **Picking a harness for newer models.** The `pi` harness resolves `model`
> against the Pi SDK's bundled model registry and throws `Unknown model` on ids it
> doesn't recognise, so it trails provider releases. The `claude` and `codex`
> harnesses hand the id straight to their SDK without validating it, so the newest
> models (e.g. `claude-opus-5`, `gpt-5.1-codex-max`) work there as soon as they ship.

### Codex harness options

> **Heads-up on install size.** `@openai/codex-sdk` wraps the `codex` CLI and pulls
> in a ~320 MB prebuilt binary for your platform, whichever harness you end up
> using. If you only ever run the `pi` or `claude` harness and want to skip it,
> install with `npm install --omit=optional` — the binary is an optional
> dependency of `@openai/codex`, and only the `codex` harness needs it.

The `codex` harness accepts an optional `codex` block in `~/.pi-pipe/settings.json`.
Its defaults match how the `pi` and `claude` harnesses already run — full workspace
access and no interactive approvals, because a chat bot has nobody at a terminal to
answer an approval prompt and a blocked turn would just hang.

```json
{
  "harness": "codex",
  "model": "gpt-5.1-codex",
  "codex": {
    "sandboxMode": "danger-full-access",
    "approvalPolicy": "never",
    "webSearch": true,
    "skipGitRepoCheck": true,
    "reasoningEffort": "medium"
  }
}
```

| Option             | What it does                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `sandboxMode`      | `read-only`, `workspace-write`, or `danger-full-access` (default) — set `workspace-write` to fence Codex into the workspace |
| `approvalPolicy`   | `never` (default), `on-request`, `on-failure`, or `untrusted` — anything but `never` will stall a chat turn                 |
| `webSearch`        | Whether Codex may search the web (default: `true`)                                                                          |
| `skipGitRepoCheck` | Allow a workspace that isn't a git repository (default: `true`)                                                             |
| `reasoningEffort`  | Optional: `minimal` … `max` — omitted means the Codex default                                                               |

Because the Codex SDK has no hook for appending to the agent's system prompt,
pi-pipe prepends its instructions (chat style, attachment / keyboard / memory
markers) to the first message of each Codex thread. Later turns inherit them from
the thread transcript, including after a restart.

### Authentication

The active harness reads provider credentials from the environment:

- `ANTHROPIC_API_KEY` — required for Claude models (and for the entire `claude` harness)
- `OPENAI_API_KEY` — required for GPT / OpenAI models (Pi and Codex harnesses)
- Other providers (Pi harness): see the [Pi providers docs](https://pi.dev/docs/latest/providers)

The `claude` harness only supports Anthropic models and the `codex` harness only
supports OpenAI models; use the `pi` harness for any other provider.

The `codex` harness shells out to the bundled `codex` CLI, which reads its own
credentials: run `codex login` once for a ChatGPT sign-in, or set `CODEX_API_KEY`
(or `OPENAI_API_KEY`) in the environment.

Set them in your shell profile or in `~/.pi-pipe/.env`.

### Advanced configuration via environment variables

For options not in the settings file, use a `.env` file in `~/.pi-pipe/` or the project root.

| Variable                          | What it does                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `PIPIPE_HARNESS`                  | Agent harness: `pi` (default), `claude`, or `codex` (overrides the settings value) |
| `PIPIPE_SESSION_STORE_PATH`       | Where to save session data (default: `{workspace}/data/sessions.json`)             |
| `PIPIPE_MAX_TOOL_ITERATIONS`      | Max tool calls per turn (default: 20)                                              |
| `PIPIPE_SUMMARY_PROMPT_ENABLED`   | Enable summary prompt templates                                                    |
| `PIPIPE_SUMMARY_PROMPT_TEMPLATE`  | Template for summary requests (supports `{{workspace}}` and `{{request}}`)         |
| `PIPIPE_TRANSCRIPT_LOG_ENABLED`   | Log conversations to a file                                                        |
| `PIPIPE_TRANSCRIPT_LOG_PATH`      | Path for transcript log file                                                       |
| `PIPIPE_TRANSCRIPT_LOG_MAX_BYTES` | Max transcript file size before rotation                                           |
| `PIPIPE_TRANSCRIPT_LOG_MAX_FILES` | Number of rotated transcript files to keep                                         |
| `PIPIPE_CLI_ENABLED`              | Enable CLI channel (`true`/`false`)                                                |
| `PIPIPE_DISCORD_ALLOW_CHANNELS`   | Comma-separated allowed Discord channel IDs (empty = allow all)                    |
| `PIPIPE_DISCORD_USE_THREADS`      | Auto-create a Discord thread per session (`true`/`false`, default: `true`)         |
| `PIPIPE_CLI_ALLOW_FROM`           | Comma-separated allowed sender IDs for CLI mode                                    |

### Permissions

Pi runs with its default tool set (read, bash, edit, write, …) — it can read/write files and run shell commands in the workspace. Make sure your workspace is a directory you're comfortable giving full access to.

## Development

```bash
npm run build    # compile TypeScript to dist/
npm run test     # run tests in watch mode
npm run test:run # run tests once
```

## Features

- **Multi-channel support**: Works with Telegram, Discord, and CLI
- **Discord session threads**: Mentioning the bot (or running a slash command) in a text channel opens a thread and continues there. Each thread is its own session, so parallel conversations never share context, and follow-ups in the thread need no mention. Disable with `PIPIPE_DISCORD_USE_THREADS=false`.
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
- No scheduled or background tasks

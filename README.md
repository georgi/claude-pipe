# claude-pipe

Talk to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) through Telegram, Discord, or a local CLI channel. Send a message, and Claude responds — with full access to read files, run commands, and work with your codebase.

Built with TypeScript. Runs locally on your machine. Inspired by [openclaw/openclaw](https://github.com/openclaw/openclaw).

## What it does

Claude Pipe connects your chat apps (or terminal) to the Claude Code CLI. When you send a message, it:

1. Picks up your message
2. Passes it to Claude (with access to your workspace)
3. Sends Claude's response back to the chat

Claude remembers previous messages in the conversation, so you can have ongoing back-and-forth sessions. It can read and edit files, run shell commands, and search the web — all the things Claude Code normally does, but triggered from your chat app.

## Getting started

You'll need [Node.js](https://nodejs.org/) 20+ and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed.

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

1. **Choose LLM runtime** — select Claude Code CLI or OpenAI Codex CLI
2. **Verify runtime CLI** — the wizard checks `claude` or `codex`
3. **Choose platform** — select Telegram, Discord, or CLI (local terminal)
4. **Enter bot token** — required for Telegram/Discord, skipped in CLI mode
5. **Webhook mode** (optional) — configure webhook server for production (recommended for containers)
6. **Select model** — provider-specific presets (Claude) or live Codex model list from your local CLI, with free-form fallback
7. **Set workspace** — specify the directory the agent can access (defaults to current directory)

Settings are saved to `~/.claude-pipe/settings.json`.

**3. Start the bot**

After setup, the bot starts automatically. To restart it later:

```bash
npm run dev     # development mode (TypeScript with tsx)
npm start       # production mode (runs compiled JavaScript)
```

**Reconfigure settings**

To change your configuration later:

```bash
npm run dev -- --reconfigure    # or -r
```

This runs the wizard again with your current values shown as defaults — press Enter to keep each setting, or type a new value.

**Command-line options**

```bash
npm run dev -- --help    # or -h
npm run dev -- --reconfigure   # or -r
```

1. **Choose LLM runtime** — Claude or Codex
2. **Verify runtime CLI** — checks selected CLI binary
3. **Choose platform** — Telegram, Discord, or CLI
4. **Enter bot token** — required for Telegram/Discord, skipped for CLI
5. **Select model** — provider-specific presets or custom model
6. **Set workspace** — specify accessible workspace path

Settings are saved to `~/.claude-pipe/settings.json`.

**3. Start chatting**

Send a message to your bot (or type in terminal if using CLI mode) and Claude will reply.

## How it works

```
Telegram / Discord / CLI
       ↓
  Your message comes in
       ↓
  Claude Code CLI processes it
  (reads files, runs commands, thinks)
       ↓
  Response sent back to chat
```

Sessions are saved to a local JSON file, so conversations survive restarts. Each chat gets its own session.

Claude operates within the workspace directory you configure. File access and shell commands are restricted to that directory for safety.

## Configuration reference

Configuration is stored in `~/.claude-pipe/settings.json` and created by the onboarding wizard.

```json
{
  "provider": "claude",
  "channel": "telegram",
  "token": "your-bot-token",
  "allowFrom": ["user-id-1", "user-id-2"],
  "model": "claude-sonnet-4-5",
  "workspace": "/path/to/your/workspace"
}
```

| Setting | What it does |
|---|---|
| `provider` | LLM runtime: `claude` or `codex` |
| `channel` | Platform to use: `telegram`, `discord`, or `cli` |
| `token` | Bot token from [BotFather](https://t.me/botfather) or [Discord Developer Portal](https://discord.com/developers/applications) |
| `allowFrom` | Array of allowed user IDs (empty = allow everyone) |
| `model` | Claude model to use (e.g., `claude-haiku-4`, `claude-sonnet-4-5`, `claude-opus-4-5`) |
| `workspace` | Root directory Claude can access |

### Advanced configuration

For advanced options like transcript logging or custom summary prompts, you can still use a `.env` file alongside the settings file. The settings file takes priority for core options.

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
| `CLAUDEPIPE_LLM_PROVIDER` | Runtime provider when using env config: `claude` or `codex` |
| `CLAUDEPIPE_CODEX_COMMAND` | Codex executable path/command (default: `codex`) |
| `CLAUDEPIPE_CODEX_ARGS` | Codex startup args (default: `app-server`) |
| `CLAUDEPIPE_CLI_ENABLED` | Enable CLI channel (`true`/`false`) |
| `CLAUDEPIPE_CLI_ALLOW_FROM` | Comma-separated allowed sender IDs for CLI mode |
| `CLAUDEPIPE_CLI_SENDER_ID` | Sender ID used by CLI channel (default: `local-user`) |
| `CLAUDEPIPE_CLI_CHAT_ID` | Chat ID used by CLI channel (default: `local-chat`) |

## Development

```bash
npm run build       # compile TypeScript to dist/
npm run dev         # run in development mode (uses tsx)
npm start           # run in production mode (uses compiled dist/)
npm run test        # run tests in watch mode
npm run test:run    # run tests once
npm run dev -- --reconfigure   # reconfigure settings
npm run dev -- --help          # show command-line options
```

## Current limitations

- Text only — no images, voice messages, or file attachments yet
- Runs locally, not designed for server deployment
- No scheduled or background tasks

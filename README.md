# claude-pipe

Talk to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) through Telegram or Discord. Send a message, and Claude responds — with full access to read files, run commands, and work with your codebase.

Built with TypeScript. Runs locally on your machine. Inspired by [openclaw/openclaw](https://github.com/openclaw/openclaw).

## What it does

Claude Pipe connects your chat apps to the Claude Code CLI. When you send a message in Telegram or Discord, it:

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

On first run, you'll be guided through an interactive setup:

1. **Verify Claude Code CLI** — the wizard checks if `claude` is installed
2. **Choose platform** — select Telegram or Discord
3. **Enter bot token** — provide your bot token from [BotFather](https://t.me/botfather) (Telegram) or the [Discord Developer Portal](https://discord.com/developers/applications)
4. **Select model** — choose Haiku, Sonnet 4.5, Opus 4.5, or enter a custom model name
5. **Set workspace** — specify the directory Claude can access (defaults to current directory)

Settings are saved to `~/.claude-pipe/settings.json`.

**3. Start chatting**

Send a message to your bot and Claude will reply.

## How it works

```
Telegram / Discord
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
  "channel": "telegram",
  "token": "your-bot-token",
  "allowFrom": ["user-id-1", "user-id-2"],
  "model": "claude-sonnet-4-5",
  "workspace": "/path/to/your/workspace"
}
```

| Setting | What it does |
|---|---|
| `channel` | Platform to use: `telegram` or `discord` |
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

## Development

```bash
npm run build       # compile TypeScript
npm run dev         # run in development mode
npm run test:run    # run tests
```

## Current limitations

- Text only — no images, voice messages, or file attachments yet
- Runs locally, not designed for server deployment
- No scheduled or background tasks

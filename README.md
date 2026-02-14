# claude-pipe

Claude Pipe is a personal AI assistant you run on your own devices. It answers you on the channels you already use (Telegram, Discord). The assistant runs locally on your machine or server and connects directly to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://developers.openai.com/codex/cli/)

Inspired by [openclaw/openclaw](https://github.com/openclaw/openclaw).

## What it does

Claude Pipe connects your chat apps (or terminal) to your Agent CLI. When you send a message, it:

1. Picks up your message
2. Passes it to the agent (with access to your workspace)
3. Sends the agent's response back to the chat

The agent remembers previous messages in the conversation, so you can have ongoing back-and-forth sessions. It can read and edit files, run shell commands, and search the web — all the things Claude Code normally does, but triggered from your chat app.

## Getting started

You'll need [Node.js](https://nodejs.org/) 20+ and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) or Codex CLI installed.

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
5. **Select model** — provider-specific presets (Claude) or live Codex model list from your local CLI, with free-form fallback
6. **Set workspace** — specify the directory the agent can access (defaults to current directory)

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
npm run dev -- --help           # or -h (show all options)
```

This runs the wizard again with your current values shown as defaults — press Enter to keep each setting, or type a new value.

**Start chatting**

Send a message to your bot (or type in terminal if using CLI mode) and the agent will reply.

## How it works

```
Telegram / Discord / CLI
       ↓
  Your message comes in
       ↓
  Agent CLI processes it
  (reads files, runs commands, thinks)
       ↓
  Response sent back to chat
```

Sessions are saved to a local JSON file, so conversations survive restarts. Each chat gets its own session.

The agent operates within the workspace directory you configure. File access and shell commands are restricted to that directory for safety.

## Configuration reference

Configuration is stored in `~/.claude-pipe/settings.json` and created by the onboarding wizard.

```json
{
  "provider": "claude",
  "claudeCli": {
    "command": "claude",
    "args": ["--print", "--verbose", "--output-format", "stream-json"]
  },
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
| `claudeCli` | Claude CLI runtime config (`command` and startup `args`) |
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
| `CLAUDEPIPE_CLAUDE_COMMAND` | Claude executable path/command (default: `claude`) |
| `CLAUDEPIPE_CLAUDE_ARGS` | Claude startup args (space-separated or JSON array) |
| `CLAUDEPIPE_CODEX_COMMAND` | Codex executable path/command (default: `codex`) |
| `CLAUDEPIPE_CODEX_ARGS` | Codex startup args (default: `--dangerously-bypass-approvals-and-sandbox app-server`) |
| `CLAUDEPIPE_CLI_ENABLED` | Enable CLI channel (`true`/`false`) |
| `CLAUDEPIPE_CLI_ALLOW_FROM` | Comma-separated allowed sender IDs for CLI mode |
| `CLAUDEPIPE_CLI_SENDER_ID` | Sender ID used by CLI channel (default: `local-user`) |
| `CLAUDEPIPE_CLI_CHAT_ID` | Chat ID used by CLI channel (default: `local-chat`) |

### Dangerous defaults and flags

This project currently ships with dangerous automation defaults for both runtimes. These settings reduce prompts and restrictions, but they can allow destructive file or shell operations if a prompt goes wrong.

- Claude default args include `--permission-mode bypassPermissions` and `--dangerously-skip-permissions`.
- Codex default args include `--dangerously-bypass-approvals-and-sandbox app-server`.

If you want safer behavior, explicitly override these:

- In `~/.claude-pipe/settings.json`, set `claudeCli.args` to remove dangerous Claude flags.
- In env, set `CLAUDEPIPE_CODEX_ARGS` without dangerous Codex flags.
- In env, tighten Codex policy with `CLAUDEPIPE_CODEX_APPROVAL_POLICY` and `CLAUDEPIPE_CODEX_SANDBOX`.

## Development

```bash
npm run build    # compile TypeScript to dist/
npm run test     # run tests in watch mode
npm run test:run # run tests once
```

## Current limitations

- Text only — no images, voice messages, or file attachments yet
- Runs locally, not designed for server deployment
- No scheduled or background tasks

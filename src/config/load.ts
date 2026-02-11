import { config as loadEnv } from 'dotenv'
import * as path from 'node:path'

import { getConfigDir, readSettings, settingsExist } from './settings.js'
import { configSchema, type ClaudePipeConfig } from './schema.js'

/** Parses comma-separated allow-list env values. */
function parseCsv(input: string | undefined): string[] {
  if (!input) return []
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseSpaceSeparatedArgs(input: string | undefined): string[] | undefined {
  if (!input) return undefined
  const trimmed = input.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed
    } catch {
      // Fall through to plain split.
    }
  }
  return trimmed.split(/\s+/).filter(Boolean)
}

/**
 * Loads runtime configuration.
 *
 * If a `~/.claude-pipe/settings.json` file exists it takes priority.
 * Otherwise falls back to the legacy `.env` / environment-variable path.
 */
export function loadConfig(): ClaudePipeConfig {
  const defaultSummaryTemplate =
    'Workspace: {{workspace}}\n' +
    'Request: {{request}}\n' +
    'Provide a concise summary with key files and actionable insights.'
  const defaultClaudeArgs = [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--permission-mode',
    'bypassPermissions',
    '--dangerously-skip-permissions'
  ]

  // Load env from ~/.claude-pipe/.env first, then local .env as a legacy fallback.
  loadEnv({ path: path.join(getConfigDir(), '.env') })
  loadEnv()

  if (settingsExist()) {
    const s = readSettings()
    const llmProvider = s.provider ?? 'claude'

    const telegramEnabled = s.channel === 'telegram'
    const discordEnabled = s.channel === 'discord'
    const cliEnabled = s.channel === 'cli'

    return configSchema.parse({
      llmProvider,
      model: s.model,
      claudeCli: {
        command: s.claudeCli?.command?.trim() || 'claude',
        args: s.claudeCli?.args ?? defaultClaudeArgs
      },
      workspace: s.workspace,
      channels: {
        telegram: {
          enabled: telegramEnabled,
          token: telegramEnabled ? s.token : '',
          allowFrom: telegramEnabled ? s.allowFrom : [],
          webhookSecret: telegramEnabled ? (s.webhook?.secret ?? '') : ''
        },
        discord: {
          enabled: discordEnabled,
          token: discordEnabled ? s.token : '',
          allowFrom: discordEnabled ? s.allowFrom : [],
          allowChannels: discordEnabled ? s.allowChannels : undefined,
          webhookSecret: discordEnabled ? (s.webhook?.secret ?? '') : ''
        },
        cli: {
          enabled: cliEnabled || process.env.CLAUDEPIPE_CLI_ENABLED === 'true',
          allowFrom: cliEnabled ? s.allowFrom : parseCsv(process.env.CLAUDEPIPE_CLI_ALLOW_FROM)
        }
      },
      webhook: {
        enabled: s.webhook?.enabled ?? false,
        port: s.webhook?.port ?? 3000,
        host: '0.0.0.0',
        url: s.webhook?.url ?? ''
      },
      summaryPrompt: {
        enabled: true,
        template: defaultSummaryTemplate
      },
      sessionStorePath: `${s.workspace}/data/sessions.json`,
      maxToolIterations: 20
    })
  }

  return configSchema.parse({
    llmProvider:
      process.env.CLAUDEPIPE_LLM_PROVIDER === 'codex' ? 'codex' : 'claude',
    model: process.env.CLAUDEPIPE_MODEL ?? '',
    claudeCli: {
      command: process.env.CLAUDEPIPE_CLAUDE_COMMAND?.trim() || 'claude',
      args: parseSpaceSeparatedArgs(process.env.CLAUDEPIPE_CLAUDE_ARGS) ?? defaultClaudeArgs
    },
    workspace: process.env.CLAUDEPIPE_WORKSPACE ?? process.cwd(),
      channels: {
        telegram: {
          enabled: process.env.CLAUDEPIPE_TELEGRAM_ENABLED === 'true',
        token: process.env.CLAUDEPIPE_TELEGRAM_TOKEN ?? '',
        allowFrom: parseCsv(process.env.CLAUDEPIPE_TELEGRAM_ALLOW_FROM),
        webhookSecret: process.env.CLAUDEPIPE_TELEGRAM_WEBHOOK_SECRET ?? ''
      },
        discord: {
          enabled: process.env.CLAUDEPIPE_DISCORD_ENABLED === 'true',
          token: process.env.CLAUDEPIPE_DISCORD_TOKEN ?? '',
          allowFrom: parseCsv(process.env.CLAUDEPIPE_DISCORD_ALLOW_FROM),
          allowChannels: parseCsv(process.env.CLAUDEPIPE_DISCORD_ALLOW_CHANNELS),
          webhookSecret: process.env.CLAUDEPIPE_DISCORD_WEBHOOK_SECRET ?? ''
        },
        cli: {
          enabled: process.env.CLAUDEPIPE_CLI_ENABLED === 'true',
          allowFrom: parseCsv(process.env.CLAUDEPIPE_CLI_ALLOW_FROM)
        }
      },
    webhook: {
      enabled: process.env.CLAUDEPIPE_WEBHOOK_ENABLED === 'true',
      port: Number(process.env.CLAUDEPIPE_WEBHOOK_PORT ?? 3000),
      host: process.env.CLAUDEPIPE_WEBHOOK_HOST ?? '0.0.0.0',
      url: process.env.CLAUDEPIPE_WEBHOOK_URL ?? ''
    },
    summaryPrompt: {
      enabled: process.env.CLAUDEPIPE_SUMMARY_PROMPT_ENABLED !== 'false',
      template: process.env.CLAUDEPIPE_SUMMARY_PROMPT_TEMPLATE ?? defaultSummaryTemplate
    },
    transcriptLog: {
      enabled: process.env.CLAUDEPIPE_TRANSCRIPT_LOG_ENABLED === 'true',
      path:
        process.env.CLAUDEPIPE_TRANSCRIPT_LOG_PATH ?? `${process.cwd()}/data/transcript.jsonl`,
      maxBytes: process.env.CLAUDEPIPE_TRANSCRIPT_LOG_MAX_BYTES
        ? Number(process.env.CLAUDEPIPE_TRANSCRIPT_LOG_MAX_BYTES)
        : 1_000_000,
      maxFiles: process.env.CLAUDEPIPE_TRANSCRIPT_LOG_MAX_FILES
        ? Number(process.env.CLAUDEPIPE_TRANSCRIPT_LOG_MAX_FILES)
        : 3
    },
    sessionStorePath:
      process.env.CLAUDEPIPE_SESSION_STORE_PATH ?? `${process.cwd()}/data/sessions.json`,
    maxToolIterations: Number(process.env.CLAUDEPIPE_MAX_TOOL_ITERATIONS ?? 20)
  })
}

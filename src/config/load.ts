import { config as loadEnv } from 'dotenv'

import { readSettings, settingsExist } from './settings.js'
import { configSchema, type ClaudePipeConfig } from './schema.js'

/** Parses comma-separated allow-list env values. */
function parseCsv(input: string | undefined): string[] {
  if (!input) return []
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
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

  if (settingsExist()) {
    const s = readSettings()

    const telegramEnabled = s.channel === 'telegram'
    const discordEnabled = s.channel === 'discord'

    return configSchema.parse({
      model: s.model,
      workspace: s.workspace,
      channels: {
        telegram: {
          enabled: telegramEnabled,
          token: telegramEnabled ? s.token : '',
          allowFrom: telegramEnabled ? s.allowFrom : []
        },
        discord: {
          enabled: discordEnabled,
          token: discordEnabled ? s.token : '',
          allowFrom: discordEnabled ? s.allowFrom : []
        }
      },
      summaryPrompt: {
        enabled: true,
        template: defaultSummaryTemplate
      },
      sessionStorePath: `${s.workspace}/data/sessions.json`,
      maxToolIterations: 20
    })
  }

  // Legacy .env fallback
  loadEnv()

  return configSchema.parse({
    model: process.env.CLAUDEPIPE_MODEL ?? 'GLM-4.7',
    workspace: process.env.CLAUDEPIPE_WORKSPACE ?? process.cwd(),
    channels: {
      telegram: {
        enabled: process.env.CLAUDEPIPE_TELEGRAM_ENABLED === 'true',
        token: process.env.CLAUDEPIPE_TELEGRAM_TOKEN ?? '',
        allowFrom: parseCsv(process.env.CLAUDEPIPE_TELEGRAM_ALLOW_FROM)
      },
      discord: {
        enabled: process.env.CLAUDEPIPE_DISCORD_ENABLED === 'true',
        token: process.env.CLAUDEPIPE_DISCORD_TOKEN ?? '',
        allowFrom: parseCsv(process.env.CLAUDEPIPE_DISCORD_ALLOW_FROM)
      }
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

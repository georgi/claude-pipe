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

/** Parses an optional boolean env value, leaving it unset when absent. */
function parseOptionalBool(input: string | undefined): boolean | undefined {
  if (input === undefined || input === '') return undefined
  return input === 'true'
}

/** Normalizes a harness string, falling back to 'pi' for unknown/missing values. */
function parseHarness(input: string | undefined): 'pi' | 'claude' | 'codex' {
  if (input === 'claude') return 'claude'
  if (input === 'codex') return 'codex'
  return 'pi'
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

  // Load env from ~/.claude-pipe/.env first, then local .env as a legacy fallback.
  loadEnv({ path: path.join(getConfigDir(), '.env') })
  loadEnv()

  if (settingsExist()) {
    const s = readSettings()

    // Apply env vars from settings to process.env (don't override existing vars)
    if (s.env) {
      for (const [key, value] of Object.entries(s.env)) {
        if (process.env[key] === undefined) {
          process.env[key] = value
        }
      }
    }

    const telegramEnabled = s.channel === 'telegram'
    const discordEnabled = s.channel === 'discord'
    const cliEnabled = s.channel === 'cli'

    return configSchema.parse({
      harness: parseHarness(process.env.CLAUDEPIPE_HARNESS ?? s.harness),
      // Omitted entirely when absent so the schema's defaults apply; passing
      // an explicit `undefined` would too, but this keeps the parsed input
      // free of keys the settings file never set.
      ...(s.codex ? { codex: s.codex } : {}),
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
          allowFrom: discordEnabled ? s.allowFrom : [],
          allowChannels: discordEnabled ? s.allowChannels : undefined,
          allowDMs: discordEnabled ? s.allowDMs : undefined,
          useThreads: discordEnabled
            ? parseOptionalBool(process.env.CLAUDEPIPE_DISCORD_USE_THREADS)
            : undefined
        },
        cli: {
          enabled: cliEnabled || process.env.CLAUDEPIPE_CLI_ENABLED === 'true',
          allowFrom: cliEnabled ? s.allowFrom : parseCsv(process.env.CLAUDEPIPE_CLI_ALLOW_FROM)
        }
      },
      summaryPrompt: {
        enabled: true,
        template: defaultSummaryTemplate
      },
      personality: s.personality,
      sessionStorePath: `${s.workspace}/data/sessions.json`,
      maxToolIterations: 20
    })
  }

  return configSchema.parse({
    harness: parseHarness(process.env.CLAUDEPIPE_HARNESS),
    model: process.env.CLAUDEPIPE_MODEL ?? '',
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
        allowFrom: parseCsv(process.env.CLAUDEPIPE_DISCORD_ALLOW_FROM),
        allowChannels: parseCsv(process.env.CLAUDEPIPE_DISCORD_ALLOW_CHANNELS),
        allowDMs: parseOptionalBool(process.env.CLAUDEPIPE_DISCORD_ALLOW_DMS),
        useThreads: parseOptionalBool(process.env.CLAUDEPIPE_DISCORD_USE_THREADS)
      },
      cli: {
        enabled: process.env.CLAUDEPIPE_CLI_ENABLED === 'true',
        allowFrom: parseCsv(process.env.CLAUDEPIPE_CLI_ALLOW_FROM)
      }
    },
    summaryPrompt: {
      enabled: process.env.CLAUDEPIPE_SUMMARY_PROMPT_ENABLED !== 'false',
      template: process.env.CLAUDEPIPE_SUMMARY_PROMPT_TEMPLATE ?? defaultSummaryTemplate
    },
    transcriptLog: {
      enabled: process.env.CLAUDEPIPE_TRANSCRIPT_LOG_ENABLED === 'true',
      path: process.env.CLAUDEPIPE_TRANSCRIPT_LOG_PATH ?? `${process.cwd()}/data/transcript.jsonl`,
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

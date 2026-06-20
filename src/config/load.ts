import { config as loadEnv } from 'dotenv'
import * as path from 'node:path'

import { getConfigDir, readSettings, settingsExist } from './settings.js'
import { configSchema, type PiPipeConfig } from './schema.js'

/** Parses comma-separated allow-list env values. */
function parseCsv(input: string | undefined): string[] {
  if (!input) return []
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Normalizes a harness string, falling back to 'pi' for unknown/missing values. */
function parseHarness(input: string | undefined): 'pi' | 'claude' {
  return input === 'claude' ? 'claude' : 'pi'
}

/** Parses a boolean env value, returning `fallback` when unset. */
function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === 'true' || value === '1'
}

/** Parses a positive integer env value, returning `fallback` on missing/invalid input. */
function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Loads runtime configuration.
 *
 * If a `~/.pi-pipe/settings.json` file exists it takes priority.
 * Otherwise falls back to the legacy `.env` / environment-variable path.
 */
export function loadConfig(): PiPipeConfig {
  const defaultSummaryTemplate =
    'Workspace: {{workspace}}\n' +
    'Request: {{request}}\n' +
    'Provide a concise summary with key files and actionable insights.'

  // Load env from ~/.pi-pipe/.env first, then local .env as a legacy fallback.
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
      harness: parseHarness(process.env.PIPIPE_HARNESS ?? s.harness),
      sandbox: parseBool(process.env.PIPIPE_SANDBOX, s.sandbox ?? false),
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
          allowChannels: discordEnabled ? s.allowChannels : undefined
        },
        cli: {
          enabled: cliEnabled || process.env.PIPIPE_CLI_ENABLED === 'true',
          allowFrom: cliEnabled ? s.allowFrom : parseCsv(process.env.PIPIPE_CLI_ALLOW_FROM)
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
    harness: parseHarness(process.env.PIPIPE_HARNESS),
    sandbox: parseBool(process.env.PIPIPE_SANDBOX, false),
    model: process.env.PIPIPE_MODEL ?? '',
    workspace: process.env.PIPIPE_WORKSPACE ?? process.cwd(),
    channels: {
      telegram: {
        enabled: process.env.PIPIPE_TELEGRAM_ENABLED === 'true',
        token: process.env.PIPIPE_TELEGRAM_TOKEN ?? '',
        allowFrom: parseCsv(process.env.PIPIPE_TELEGRAM_ALLOW_FROM)
      },
      discord: {
        enabled: process.env.PIPIPE_DISCORD_ENABLED === 'true',
        token: process.env.PIPIPE_DISCORD_TOKEN ?? '',
        allowFrom: parseCsv(process.env.PIPIPE_DISCORD_ALLOW_FROM),
        allowChannels: parseCsv(process.env.PIPIPE_DISCORD_ALLOW_CHANNELS)
      },
      cli: {
        enabled: process.env.PIPIPE_CLI_ENABLED === 'true',
        allowFrom: parseCsv(process.env.PIPIPE_CLI_ALLOW_FROM)
      }
    },
    summaryPrompt: {
      enabled: process.env.PIPIPE_SUMMARY_PROMPT_ENABLED !== 'false',
      template: process.env.PIPIPE_SUMMARY_PROMPT_TEMPLATE ?? defaultSummaryTemplate
    },
    transcriptLog: {
      enabled: process.env.PIPIPE_TRANSCRIPT_LOG_ENABLED === 'true',
      path: process.env.PIPIPE_TRANSCRIPT_LOG_PATH ?? `${process.cwd()}/data/transcript.jsonl`,
      maxBytes: parseIntOr(process.env.PIPIPE_TRANSCRIPT_LOG_MAX_BYTES, 1_000_000),
      maxFiles: parseIntOr(process.env.PIPIPE_TRANSCRIPT_LOG_MAX_FILES, 3)
    },
    sessionStorePath:
      process.env.PIPIPE_SESSION_STORE_PATH ?? `${process.cwd()}/data/sessions.json`,
    maxToolIterations: parseIntOr(process.env.PIPIPE_MAX_TOOL_ITERATIONS, 20)
  })
}

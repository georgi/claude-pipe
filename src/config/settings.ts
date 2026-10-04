import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import type { ClaudePipeConfig } from './schema.js'

/**
 * Persisted settings stored in ~/.claude-pipe/settings.json.
 */
export interface PersonalitySettings {
  name: string
  traits: string
}

/**
 * Codex-harness options as they appear in settings.json.
 *
 * Derived from the config schema so the two can't drift, and partial because
 * every field has a schema-level default — omitting one keeps that default
 * rather than clearing it.
 */
export type CodexSettings = Partial<ClaudePipeConfig['codex']>

export interface Settings {
  channel: 'telegram' | 'discord' | 'cli'
  token: string
  allowFrom: string[]
  // Optional allowlist of Discord channel IDs. Empty/missing means allow all channels.
  allowChannels?: string[]
  // Accept Discord DMs. Omitted means: only when allowFrom is non-empty.
  allowDMs?: boolean
  // Which agent harness drives conversations. Defaults to 'pi' when omitted.
  harness?: 'pi' | 'claude' | 'codex'
  // Codex-harness options; ignored by the other harnesses.
  codex?: CodexSettings
  model: string
  workspace: string
  personality?: PersonalitySettings
  env?: Record<string, string>
}

function defaultConfigDir(): string {
  return process.env.CLAUDE_PIPE_CONFIG_DIR || path.join(os.homedir(), '.claude-pipe')
}

/** Returns the resolved path to the settings directory. */
export function getConfigDir(): string {
  return defaultConfigDir()
}

/** Returns the resolved path to the settings file. */
export function getSettingsPath(): string {
  return path.join(defaultConfigDir(), 'settings.json')
}

/** Returns true when a settings file already exists. */
export function settingsExist(): boolean {
  return fs.existsSync(getSettingsPath())
}

/** Reads and parses the settings file. Throws if missing or malformed. */
export function readSettings(): Settings {
  const raw = fs.readFileSync(getSettingsPath(), 'utf-8')
  return JSON.parse(raw) as Settings
}

/** Writes settings to disk, creating the config directory if needed. */
export function writeSettings(settings: Settings): void {
  const dir = defaultConfigDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
    'utf-8'
  )
}

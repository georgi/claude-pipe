import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

/**
 * Persisted settings stored in ~/.pi-pipe/settings.json.
 */
export interface PersonalitySettings {
  name: string
  traits: string
}

export interface Settings {
  channel: 'telegram' | 'discord' | 'cli'
  token: string
  allowFrom: string[]
  // Optional allowlist of Discord channel IDs. Empty/missing means allow all channels.
  allowChannels?: string[]
  // Which agent harness drives conversations. Defaults to 'pi' when omitted.
  harness?: 'pi' | 'claude'
  // When true, lock the agent into a restricted sandbox (no bash/edit/write,
  // no sensitive-path reads). Defaults to false when omitted.
  sandbox?: boolean
  model: string
  workspace: string
  personality?: PersonalitySettings
  env?: Record<string, string>
}

function defaultConfigDir(): string {
  return process.env.PI_PIPE_CONFIG_DIR || path.join(os.homedir(), '.pi-pipe')
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

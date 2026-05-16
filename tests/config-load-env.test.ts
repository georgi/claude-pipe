import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: vi.fn(actual.homedir)
  }
})

import { homedir } from 'node:os'

const mockedHomedir = homedir as unknown as ReturnType<typeof vi.fn>

const ENV_KEYS = [
  'PIPIPE_MODEL',
  'PIPIPE_WORKSPACE',
  'PIPIPE_TELEGRAM_ENABLED',
  'PIPIPE_TELEGRAM_TOKEN',
  'PIPIPE_TELEGRAM_ALLOW_FROM',
  'PIPIPE_DISCORD_ENABLED',
  'PIPIPE_DISCORD_TOKEN',
  'PIPIPE_DISCORD_ALLOW_FROM',
  'PIPIPE_DISCORD_ALLOW_CHANNELS',
  'PIPIPE_CLI_ENABLED',
  'PIPIPE_CLI_ALLOW_FROM',
  'PIPIPE_SUMMARY_PROMPT_ENABLED',
  'PIPIPE_SUMMARY_PROMPT_TEMPLATE',
  'PIPIPE_TRANSCRIPT_LOG_ENABLED',
  'PIPIPE_TRANSCRIPT_LOG_PATH',
  'PIPIPE_TRANSCRIPT_LOG_MAX_BYTES',
  'PIPIPE_TRANSCRIPT_LOG_MAX_FILES',
  'PIPIPE_SESSION_STORE_PATH',
  'PIPIPE_MAX_TOOL_ITERATIONS'
]

describe('loadConfig', () => {
  let fakeHome: string
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'pi-pipe-load-config-'))
    mockedHomedir.mockReturnValue(fakeHome)
    for (const k of ENV_KEYS) {
      originalEnv[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true })
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k]
      else process.env[k] = originalEnv[k]
    }
    vi.resetModules()
  })

  it('falls back to env vars when no settings file exists (cli channel)', async () => {
    process.env.PIPIPE_MODEL = 'claude-haiku-4-5'
    process.env.PIPIPE_WORKSPACE = '/tmp/env-ws'
    process.env.PIPIPE_CLI_ENABLED = 'true'
    process.env.PIPIPE_CLI_ALLOW_FROM = 'alice,bob'
    process.env.PIPIPE_SESSION_STORE_PATH = '/tmp/sessions.json'
    process.env.PIPIPE_MAX_TOOL_ITERATIONS = '7'

    vi.resetModules()
    const { loadConfig } = await import('../src/config/load.js')
    const cfg = loadConfig()

    expect(cfg.model).toBe('claude-haiku-4-5')
    expect(cfg.workspace).toBe('/tmp/env-ws')
    expect(cfg.channels.cli?.enabled).toBe(true)
    expect(cfg.channels.cli?.allowFrom).toEqual(['alice', 'bob'])
    expect(cfg.sessionStorePath).toBe('/tmp/sessions.json')
    expect(cfg.maxToolIterations).toBe(7)
  })

  it('parses telegram/discord env-var channel configuration', async () => {
    process.env.PIPIPE_MODEL = 'gpt-5'
    process.env.PIPIPE_WORKSPACE = '/tmp/x'
    process.env.PIPIPE_TELEGRAM_ENABLED = 'true'
    process.env.PIPIPE_TELEGRAM_TOKEN = 'tg-tok'
    process.env.PIPIPE_TELEGRAM_ALLOW_FROM = '100,200'
    process.env.PIPIPE_DISCORD_ENABLED = 'true'
    process.env.PIPIPE_DISCORD_TOKEN = 'dc-tok'
    process.env.PIPIPE_DISCORD_ALLOW_CHANNELS = 'chan-a,chan-b'

    vi.resetModules()
    const { loadConfig } = await import('../src/config/load.js')
    const cfg = loadConfig()

    expect(cfg.channels.telegram.enabled).toBe(true)
    expect(cfg.channels.telegram.token).toBe('tg-tok')
    expect(cfg.channels.telegram.allowFrom).toEqual(['100', '200'])
    expect(cfg.channels.discord.enabled).toBe(true)
    expect(cfg.channels.discord.token).toBe('dc-tok')
    expect(cfg.channels.discord.allowChannels).toEqual(['chan-a', 'chan-b'])
  })

  it('honours transcript-log env vars', async () => {
    process.env.PIPIPE_MODEL = 'claude-sonnet-4-5'
    process.env.PIPIPE_WORKSPACE = '/tmp/x'
    process.env.PIPIPE_TRANSCRIPT_LOG_ENABLED = 'true'
    process.env.PIPIPE_TRANSCRIPT_LOG_PATH = '/tmp/transcripts.jsonl'
    process.env.PIPIPE_TRANSCRIPT_LOG_MAX_BYTES = '500'
    process.env.PIPIPE_TRANSCRIPT_LOG_MAX_FILES = '4'

    vi.resetModules()
    const { loadConfig } = await import('../src/config/load.js')
    const cfg = loadConfig()

    expect(cfg.transcriptLog.enabled).toBe(true)
    expect(cfg.transcriptLog.path).toBe('/tmp/transcripts.jsonl')
    expect(cfg.transcriptLog.maxBytes).toBe(500)
    expect(cfg.transcriptLog.maxFiles).toBe(4)
  })

  it('loads from ~/.pi-pipe/settings.json when present', async () => {
    const settingsDir = join(fakeHome, '.pi-pipe')
    await writeFile.bind(null) // ensure import OK
    // Create the dir and file
    const fsp = await import('node:fs/promises')
    await fsp.mkdir(settingsDir, { recursive: true })
    await fsp.writeFile(
      join(settingsDir, 'settings.json'),
      JSON.stringify({
        channel: 'telegram',
        token: 'tg-token-from-settings',
        allowFrom: ['boss'],
        model: 'claude-sonnet-4-5',
        workspace: fakeHome,
        env: { CUSTOM_KEY: 'hello' }
      }),
      'utf-8'
    )

    const originalCustom = process.env.CUSTOM_KEY
    delete process.env.CUSTOM_KEY
    try {
      vi.resetModules()
      const { loadConfig } = await import('../src/config/load.js')
      const cfg = loadConfig()

      expect(cfg.channels.telegram.enabled).toBe(true)
      expect(cfg.channels.telegram.token).toBe('tg-token-from-settings')
      expect(cfg.channels.telegram.allowFrom).toEqual(['boss'])
      expect(cfg.channels.discord.enabled).toBe(false)
      expect(process.env.CUSTOM_KEY).toBe('hello')
    } finally {
      if (originalCustom === undefined) delete process.env.CUSTOM_KEY
      else process.env.CUSTOM_KEY = originalCustom
    }
  })

  it('does not override existing env vars with settings.env', async () => {
    const settingsDir = join(fakeHome, '.pi-pipe')
    const fsp = await import('node:fs/promises')
    await fsp.mkdir(settingsDir, { recursive: true })
    await fsp.writeFile(
      join(settingsDir, 'settings.json'),
      JSON.stringify({
        channel: 'cli',
        token: '',
        allowFrom: [],
        model: 'claude-sonnet-4-5',
        workspace: fakeHome,
        env: { ALREADY_SET: 'from-settings' }
      }),
      'utf-8'
    )

    const originalAlready = process.env.ALREADY_SET
    process.env.ALREADY_SET = 'from-shell'
    try {
      vi.resetModules()
      const { loadConfig } = await import('../src/config/load.js')
      loadConfig()

      expect(process.env.ALREADY_SET).toBe('from-shell')
    } finally {
      if (originalAlready === undefined) delete process.env.ALREADY_SET
      else process.env.ALREADY_SET = originalAlready
    }
  })
})

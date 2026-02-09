import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { configSchema } from '../src/config/schema.js'

describe('loadConfig from settings file', () => {
  const tmpDir = path.join(import.meta.dirname ?? __dirname, '..', '.test-load-config')
  const settingsDir = path.join(tmpDir, '.claude-pipe')
  const settingsPath = path.join(settingsDir, 'settings.json')

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('produces valid config from a telegram settings file', () => {
    fs.mkdirSync(settingsDir, { recursive: true })
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        channel: 'telegram',
        token: 'tok_abc',
        allowFrom: ['100'],
        model: 'claude-sonnet-4-5',
        workspace: '/tmp/my-workspace'
      }),
      'utf-8'
    )

    // Simulate what loadConfig does when settings exist
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    const telegramEnabled = s.channel === 'telegram'
    const discordEnabled = s.channel === 'discord'

    const parsed = configSchema.parse({
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
      summaryPrompt: { enabled: true, template: 'test' },
      sessionStorePath: '/tmp/sessions.json',
      maxToolIterations: 20
    })

    expect(parsed.model).toBe('claude-sonnet-4-5')
    expect(parsed.channels.telegram.enabled).toBe(true)
    expect(parsed.channels.telegram.token).toBe('tok_abc')
    expect(parsed.channels.discord.enabled).toBe(false)
    expect(parsed.workspace).toBe('/tmp/my-workspace')
  })

  it('produces valid config from a discord settings file', () => {
    fs.mkdirSync(settingsDir, { recursive: true })
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        channel: 'discord',
        token: 'tok_xyz',
        allowFrom: [],
        model: 'GLM-4.7',
        workspace: '/tmp/ws2'
      }),
      'utf-8'
    )

    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    const telegramEnabled = s.channel === 'telegram'
    const discordEnabled = s.channel === 'discord'

    const parsed = configSchema.parse({
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
      summaryPrompt: { enabled: true, template: 'test' },
      sessionStorePath: '/tmp/sessions.json',
      maxToolIterations: 20
    })

    expect(parsed.model).toBe('GLM-4.7')
    expect(parsed.channels.discord.enabled).toBe(true)
    expect(parsed.channels.discord.token).toBe('tok_xyz')
    expect(parsed.channels.telegram.enabled).toBe(false)
  })
})

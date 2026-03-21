import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_HOME = path.join(import.meta.dirname ?? __dirname, '..', '.test-home')

vi.mock('node:os', () => ({ homedir: () => TEST_HOME }))

describe('settings', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_HOME, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  })

  it('settingsExist returns false when file does not exist', async () => {
    const { settingsExist } = await import('../src/config/settings.js')
    expect(settingsExist()).toBe(false)
  })

  it('writeSettings creates file and readSettings returns it', async () => {
    const { writeSettings, readSettings, settingsExist } = await import('../src/config/settings.js')
    const data = {
      channel: 'telegram' as const,
      token: 'tok_123',
      allowFrom: ['42'],
      model: 'claude-sonnet-4-5',
      workspace: '/tmp/ws'
    }
    writeSettings(data)
    expect(settingsExist()).toBe(true)

    const loaded = readSettings()
    expect(loaded.channel).toBe('telegram')
    expect(loaded.token).toBe('tok_123')
    expect(loaded.model).toBe('claude-sonnet-4-5')
    expect(loaded.workspace).toBe('/tmp/ws')
    expect(loaded.allowFrom).toEqual(['42'])
  })
})

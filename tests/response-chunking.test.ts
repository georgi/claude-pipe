import { describe, expect, it, vi, afterEach } from 'vitest'

import type { MicroclawConfig } from '../src/config/schema.js'
import { TelegramChannel } from '../src/channels/telegram.js'
import { DiscordChannel } from '../src/channels/discord.js'
import { MessageBus } from '../src/core/bus.js'

function makeConfig(): MicroclawConfig {
  return {
    model: 'claude-sonnet-4-5',
    workspace: '/tmp/workspace',
    channels: {
      telegram: { enabled: true, token: 'TKN', allowFrom: [] },
      discord: { enabled: true, token: 'DTKN', allowFrom: [] }
    },
    tools: { execTimeoutSec: 60, webSearchApiKey: undefined },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20
  }
}

describe('response chunking', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('splits long Telegram responses into multiple sendMessage calls', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })) as unknown as typeof fetch
    global.fetch = fetchMock

    const longContent = 'a'.repeat(5000)
    await channel.send({ channel: 'telegram', chatId: '123', content: longContent })

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('splits long Discord responses into multiple send calls', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, logger)

    const send = vi.fn(async () => undefined)
    const fetch = vi.fn(async () => ({ isTextBased: () => true, send }))
    ;(channel as any).client = { channels: { fetch } }

    const longContent = 'b'.repeat(2500)
    await channel.send({ channel: 'discord', chatId: 'abc', content: longContent })

    expect(send.mock.calls.length).toBeGreaterThan(1)
  })
})

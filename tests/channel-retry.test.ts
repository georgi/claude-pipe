import { describe, expect, it, vi, afterEach } from 'vitest'

import type { MicroclawConfig } from '../src/config/schema.js'
import { DiscordChannel } from '../src/channels/discord.js'
import { TelegramChannel } from '../src/channels/telegram.js'
import { MessageBus } from '../src/core/bus.js'

function makeConfig(): MicroclawConfig {
  return {
    model: 'claude-sonnet-4-5',
    workspace: '/tmp/workspace',
    channels: {
      telegram: { enabled: true, token: 'TKN', allowFrom: [] },
      discord: { enabled: true, token: 'DTKN', allowFrom: [] }
    },
    tools: { execTimeoutSec: 60 },
    summaryPrompt: { enabled: true, template: 'Workspace: {{workspace}} Request: {{request}}' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20
  }
}

describe('channel retry behavior', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('retries Telegram send and succeeds on second attempt', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'error' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' }) as unknown as typeof fetch
    global.fetch = fetchMock

    await channel.send({ channel: 'telegram', chatId: '123', content: 'hello' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries Discord send and succeeds on second attempt', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, logger)

    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined)
    const fetch = vi.fn(async () => ({ isTextBased: () => true, send }))

    ;(channel as any).client = { channels: { fetch } }

    await channel.send({ channel: 'discord', chatId: 'abc', content: 'reply' })

    expect(send).toHaveBeenCalledTimes(2)
  })
})

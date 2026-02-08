import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { MessageBus } from '../src/core/bus.js'
import type { MicroclawConfig } from '../src/config/schema.js'
import { TelegramChannel } from '../src/channels/telegram.js'

function makeConfig(): MicroclawConfig {
  return {
    model: 'claude-sonnet-4-5',
    workspace: '/tmp/workspace',
    channels: {
      telegram: { enabled: true, token: 'TEST_TOKEN', allowFrom: ['100'] },
      discord: { enabled: false, token: '', allowFrom: [] }
    },
    tools: { execTimeoutSec: 60 },
    summaryPrompt: { enabled: true, template: 'Workspace: {{workspace}} Request: {{request}}' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20
  }
}

describe('TelegramChannel', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('publishes inbound message when sender is allowed', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    await (channel as any).handleMessage({
      update_id: 1,
      message: {
        message_id: 9,
        text: 'summarize files',
        chat: { id: 200 },
        from: { id: 100 }
      }
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.channel).toBe('telegram')
    expect(inbound.chatId).toBe('200')
    expect(inbound.senderId).toBe('100')
    expect(inbound.content).toBe('summarize files')
  })

  it('drops inbound message when sender is not allowed', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    await (channel as any).handleMessage({
      update_id: 1,
      message: {
        message_id: 9,
        text: 'blocked',
        chat: { id: 200 },
        from: { id: 999 }
      }
    })

    const outcome = await Promise.race([
      bus.consumeInbound().then(() => 'published'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 20))
    ])
    expect(outcome).toBe('timeout')
  })

  it('sends outbound text through Telegram Bot API', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => ''
    })) as unknown as typeof fetch

    global.fetch = fetchMock

    await channel.send({ channel: 'telegram', chatId: '200', content: 'hello' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://api.telegram.org/botTEST_TOKEN/sendMessage')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toContain('"chat_id":200')
    expect(String(init.body)).toContain('"text":"hello"')
  })
})

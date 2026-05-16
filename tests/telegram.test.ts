import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { MessageBus } from '../src/core/bus.js'
import type { PiPipeConfig } from '../src/config/schema.js'
import { TelegramChannel } from '../src/channels/telegram.js'

function makeConfig(): PiPipeConfig {
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

  it('returns SentMessage with message_id from send', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ ok: true, result: { message_id: 555 } })
    })) as unknown as typeof fetch

    global.fetch = fetchMock

    const sent = await channel.send({ channel: 'telegram', chatId: '200', content: 'hello' })

    expect(sent).toEqual({ channel: 'telegram', chatId: '200', messageId: '555' })
  })

  it('edits a previously sent message via editMessageText', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => ''
    })) as unknown as typeof fetch

    global.fetch = fetchMock

    await channel.editMessage(
      { channel: 'telegram', chatId: '200', messageId: '555' },
      'updated text'
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://api.telegram.org/botTEST_TOKEN/editMessageText')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toContain('"chat_id":200')
    expect(String(init.body)).toContain('"message_id":555')
    expect(String(init.body)).toContain('"text":"updated text"')
  })

  it('sends a streaming draft via sendMessageDraft API with draft_id', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => ''
    })) as unknown as typeof fetch

    global.fetch = fetchMock

    const sent = await channel.sendMessageDraft('200', 'partial response...')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://api.telegram.org/botTEST_TOKEN/sendMessageDraft')
    expect(init.method).toBe('POST')
    const body = String(init.body)
    expect(body).toContain('"chat_id":200')
    expect(body).toContain('"draft_id":1')
    expect(body).toContain('"text":"partial response..."')
    // sendMessageDraft returns True, not a message — so no SentMessage
    expect(sent).toBeUndefined()
  })

  it('logs error when sendMessageDraft fails', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'Bad Request'
    })) as unknown as typeof fetch

    global.fetch = fetchMock

    const sent = await channel.sendMessageDraft('200', 'partial response...')
    expect(sent).toBeUndefined()
  })

  it('send() is a no-op when telegram channel is disabled', async () => {
    const cfg = makeConfig()
    cfg.channels.telegram.enabled = false
    const channel = new TelegramChannel(cfg, new MessageBus(), logger)

    const fetchMock = vi.fn() as unknown as typeof fetch
    global.fetch = fetchMock

    await channel.send({ channel: 'telegram', chatId: '1', content: 'x' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('send() with progress metadata fires the typing chat action', async () => {
    const channel = new TelegramChannel(makeConfig(), new MessageBus(), logger)

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => ''
    })) as unknown as typeof fetch
    global.fetch = fetchMock

    await channel.send({
      channel: 'telegram',
      chatId: '200',
      content: '',
      metadata: { kind: 'progress' }
    })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('sendChatAction')
  })

  it('start() is a no-op when telegram is disabled', async () => {
    const cfg = makeConfig()
    cfg.channels.telegram.enabled = false
    const channel = new TelegramChannel(cfg, new MessageBus(), logger)
    await channel.start()
    await channel.stop()
  })

  it('start() warns when token is missing', async () => {
    const cfg = makeConfig()
    cfg.channels.telegram.token = ''
    const channel = new TelegramChannel(cfg, new MessageBus(), logger)
    await channel.start()
    expect(logger.warn).toHaveBeenCalledWith(
      'channel.telegram.misconfigured',
      expect.any(Object)
    )
  })

  it('retries without Markdown parse_mode when entities cannot be parsed', async () => {
    const channel = new TelegramChannel(makeConfig(), new MessageBus(), logger)

    let call = 0
    const fetchMock = vi.fn(async () => {
      call++
      if (call === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => `Bad Request: can't parse entities`
        }
      }
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ ok: true, result: { message_id: 77 } })
      }
    }) as unknown as typeof fetch
    global.fetch = fetchMock

    const sent = await channel.send({
      channel: 'telegram',
      chatId: '200',
      content: 'bad *markdown'
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The fallback omits parse_mode
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(String(init.body)).not.toContain('parse_mode')
    expect(sent).toBeUndefined() // first try returned ok=false; we don't parse second body for ID
  })

  it('processes callback_query as an inbound "[Button pressed]" message', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ ok: true })
    })) as unknown as typeof fetch
    global.fetch = fetchMock

    await (channel as unknown as { handleCallbackQuery: (q: unknown) => Promise<void> }).handleCallbackQuery({
      id: 'cb-1',
      data: 'menu_open',
      from: { id: 100 },
      message: { message_id: 1, chat: { id: 200 } }
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.content).toContain('Button pressed')
    expect(inbound.content).toContain('menu_open')
    expect(inbound.chatId).toBe('200')
  })

  it('drops callback_query from a non-allowed sender', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    await (channel as unknown as { handleCallbackQuery: (q: unknown) => Promise<void> }).handleCallbackQuery({
      id: 'cb-2',
      data: 'menu_open',
      from: { id: 999 },
      message: { message_id: 1, chat: { id: 200 } }
    })

    const outcome = await Promise.race([
      bus.consumeInbound().then(() => 'published'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 20))
    ])
    expect(outcome).toBe('timeout')
  })
})

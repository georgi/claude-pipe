import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { MessageBus } from '../src/core/bus.js'
import type { ClaudePipeConfig } from '../src/config/schema.js'
import { TelegramChannel } from '../src/channels/telegram.js'

function makeConfig(): ClaudePipeConfig {
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

  it('processes photo attachment and includes in inbound message', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/getFile')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: { file_path: 'photos/file_123.jpg' }
          })
        }
      }
      return { ok: false }
    }) as unknown as typeof fetch

    global.fetch = fetchMock

    await (channel as any).handleMessage({
      update_id: 2,
      message: {
        message_id: 10,
        caption: 'Check this image',
        photo: [
          { file_id: 'file_123', file_unique_id: 'unique_123', width: 100, height: 100, file_size: 5000 },
          { file_id: 'file_123', file_unique_id: 'unique_123', width: 200, height: 200, file_size: 15000 }
        ],
        chat: { id: 200 },
        from: { id: 100 }
      }
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.channel).toBe('telegram')
    expect(inbound.content).toBe('Check this image')
    expect(inbound.attachments).toBeDefined()
    expect(inbound.attachments?.length).toBe(1)
    expect(inbound.attachments?.[0].type).toBe('image')
    expect(inbound.attachments?.[0].filename).toBe('file_123.jpg')
    expect(inbound.attachments?.[0].url).toContain('https://api.telegram.org/file/botTEST_TOKEN/photos/file_123.jpg')
  })

  it('processes document attachment and includes in inbound message', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/getFile')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: { file_path: 'documents/report.pdf' }
          })
        }
      }
      return { ok: false }
    }) as unknown as typeof fetch

    global.fetch = fetchMock

    await (channel as any).handleMessage({
      update_id: 3,
      message: {
        message_id: 11,
        caption: 'Review this PDF',
        document: {
          file_id: 'doc_456',
          file_unique_id: 'unique_456',
          file_name: 'report.pdf',
          mime_type: 'application/pdf',
          file_size: 102400
        },
        chat: { id: 200 },
        from: { id: 100 }
      }
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.channel).toBe('telegram')
    expect(inbound.content).toBe('Review this PDF')
    expect(inbound.attachments).toBeDefined()
    expect(inbound.attachments?.length).toBe(1)
    expect(inbound.attachments?.[0].type).toBe('document')
    expect(inbound.attachments?.[0].filename).toBe('report.pdf')
    expect(inbound.attachments?.[0].mimeType).toBe('application/pdf')
  })

  it('sends outbound message with image attachment', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => ''
    })) as unknown as typeof fetch

    global.fetch = fetchMock

    await channel.send({
      channel: 'telegram',
      chatId: '200',
      content: 'Here is an image',
      attachments: [{
        type: 'image',
        url: 'https://example.com/image.jpg',
        filename: 'image.jpg'
      }]
    })

    // Should call sendPhoto for attachment, then sendMessage for text
    expect(fetchMock).toHaveBeenCalledTimes(2)
    
    // First call: sendPhoto
    const [photoUrl, photoInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(photoUrl).toContain('https://api.telegram.org/botTEST_TOKEN/sendPhoto')
    expect(String(photoInit.body)).toContain('"photo":"https://example.com/image.jpg"')
    expect(String(photoInit.body)).toContain('"caption":"image.jpg"')
    
    // Second call: sendMessage
    const [textUrl, textInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(textUrl).toContain('https://api.telegram.org/botTEST_TOKEN/sendMessage')
    expect(String(textInit.body)).toContain('"text":"Here is an image"')
  })

  it('sends outbound message with document attachment', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => ''
    })) as unknown as typeof fetch

    global.fetch = fetchMock

    await channel.send({
      channel: 'telegram',
      chatId: '200',
      content: 'Here is a document',
      attachments: [{
        type: 'document',
        url: 'https://example.com/report.pdf',
        filename: 'report.pdf'
      }]
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    
    // First call: sendDocument
    const [docUrl, docInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(docUrl).toContain('https://api.telegram.org/botTEST_TOKEN/sendDocument')
    expect(String(docInit.body)).toContain('"document":"https://example.com/report.pdf"')
  })

  it('sends outbound attachment without text content', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

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
      attachments: [{
        type: 'video',
        url: 'https://example.com/video.mp4',
        filename: 'video.mp4'
      }]
    })

    // Should only call sendVideo, not sendMessage since content is empty
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [videoUrl] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(videoUrl).toContain('https://api.telegram.org/botTEST_TOKEN/sendVideo')
  })
})

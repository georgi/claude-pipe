import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MessageBus } from '../src/core/bus.js'
import { TelegramChannel } from '../src/channels/telegram.js'
import type { PiPipeConfig } from '../src/config/schema.js'

function makeConfig(): PiPipeConfig {
  return {
    model: 'claude-sonnet-4-5',
    workspace: '/tmp/workspace',
    channels: {
      telegram: { enabled: true, token: 'TEST_TOKEN', allowFrom: ['100'] },
      discord: { enabled: false, token: '', allowFrom: [] }
    },
    summaryPrompt: { enabled: false, template: '' },
    transcriptLog: { enabled: false, path: '/tmp/t' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20
  } as PiPipeConfig
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.resetAllMocks()
})

beforeEach(() => {
  vi.resetAllMocks()
})

describe('TelegramChannel — file resolution & sending', () => {
  it('getFilePath returns null when Telegram returns ok=false', async () => {
    const channel = new TelegramChannel(makeConfig(), new MessageBus(), logger)

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false })
    })) as unknown as typeof fetch

    const result = await (
      channel as unknown as { getFilePath: (id: string) => Promise<string | null> }
    ).getFilePath('file-1')
    expect(result).toBeNull()
  })

  it('getFilePath returns the resolved path when Telegram returns ok=true', async () => {
    const channel = new TelegramChannel(makeConfig(), new MessageBus(), logger)

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { file_path: 'photos/abc.jpg' } })
    })) as unknown as typeof fetch

    const result = await (
      channel as unknown as { getFilePath: (id: string) => Promise<string | null> }
    ).getFilePath('file-1')
    expect(result).toBe('photos/abc.jpg')
  })

  it('getFilePath returns null on HTTP error', async () => {
    const channel = new TelegramChannel(makeConfig(), new MessageBus(), logger)

    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500
    })) as unknown as typeof fetch

    const result = await (
      channel as unknown as { getFilePath: (id: string) => Promise<string | null> }
    ).getFilePath('file-1')
    expect(result).toBeNull()
  })

  it('buildInlineKeyboard maps rows of buttons into Telegram reply_markup', () => {
    const channel = new TelegramChannel(makeConfig(), new MessageBus(), logger)
    const out = (
      channel as unknown as {
        buildInlineKeyboard: (
          k: Array<Array<{ text: string; callbackData: string }>>
        ) => Record<string, unknown>
      }
    ).buildInlineKeyboard([
      [
        { text: 'Yes', callbackData: 'y' },
        { text: 'No', callbackData: 'n' }
      ]
    ])
    expect(out).toEqual({
      inline_keyboard: [
        [
          { text: 'Yes', callback_data: 'y' },
          { text: 'No', callback_data: 'n' }
        ]
      ]
    })
  })

  it('answerCallbackQuery swallows non-critical errors silently', async () => {
    const channel = new TelegramChannel(makeConfig(), new MessageBus(), logger)
    global.fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    await expect(
      (
        channel as unknown as { answerCallbackQuery: (id: string) => Promise<void> }
      ).answerCallbackQuery('cb-1')
    ).resolves.toBeUndefined()
  })

  it('send() with an inline keyboard attaches reply_markup to the last chunk', async () => {
    const channel = new TelegramChannel(makeConfig(), new MessageBus(), logger)
    const captured: RequestInit[] = []

    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init) captured.push(init)
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ ok: true, result: { message_id: 1 } })
      }
    }) as unknown as typeof fetch

    await channel.send({
      channel: 'telegram',
      chatId: '200',
      content: 'pick one',
      keyboard: [[{ text: 'A', callbackData: 'a' }]]
    })

    const body = String(captured[0]?.body ?? '')
    expect(body).toContain('reply_markup')
    expect(body).toContain('callback_data')
  })

  it('send() includes attachments via sendFile after the text', async () => {
    const channel = new TelegramChannel(makeConfig(), new MessageBus(), logger)
    const calls: string[] = []
    global.fetch = vi.fn(async (url: string) => {
      calls.push(String(url))
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ ok: true, result: { message_id: 1 } })
      }
    }) as unknown as typeof fetch

    // sendFile relies on createReadStream which needs a real file — instead, intercept the method.
    const sendFileSpy = vi
      .spyOn(channel, 'sendFile')
      .mockResolvedValue({ channel: 'telegram', chatId: '200', messageId: '999' })

    const result = await channel.send({
      channel: 'telegram',
      chatId: '200',
      content: 'with attachment',
      attachments: [{ filePath: '/tmp/test.png' }]
    })

    expect(sendFileSpy).toHaveBeenCalledWith('200', { filePath: '/tmp/test.png' })
    expect(result?.messageId).toBe('999')
  })

  it('logs a send_failed error when all retries fail', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const channel = new TelegramChannel(makeConfig(), new MessageBus(), log)

    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => 'service unavailable'
    })) as unknown as typeof fetch

    await channel.send({ channel: 'telegram', chatId: '200', content: 'hi' })
    expect(log.error).toHaveBeenCalledWith('channel.telegram.send_failed', expect.any(Object))
  })

  it('editMessage logs error when retry fails', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const channel = new TelegramChannel(makeConfig(), new MessageBus(), log)

    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'bad request'
    })) as unknown as typeof fetch

    await channel.editMessage({ channel: 'telegram', chatId: '200', messageId: '555' }, 'updated')
    expect(log.error).toHaveBeenCalledWith('channel.telegram.edit_failed', expect.any(Object))
  })

  it('editMessage falls back to parse_mode-less retry on parse error', async () => {
    const channel = new TelegramChannel(makeConfig(), new MessageBus(), logger)

    let call = 0
    const captured: RequestInit[] = []
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      call++
      if (init) captured.push(init)
      if (call === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => `Bad Request: can't parse entities`
        }
      }
      return { ok: true, status: 200, text: async () => '' }
    }) as unknown as typeof fetch

    await channel.editMessage(
      { channel: 'telegram', chatId: '200', messageId: '555' },
      'bad *markdown'
    )

    expect(call).toBe(2)
    expect(String(captured[1]?.body ?? '')).not.toContain('parse_mode')
  })

  it('static formatBotFatherCommands renders <name> - <description> lines', () => {
    const out = TelegramChannel.formatBotFatherCommands([
      {
        name: 'help',
        description: 'Show help',
        category: 'utility',
        telegramName: 'help'
      },
      {
        name: 'session_new',
        description: 'Start a new session',
        category: 'session',
        telegramName: 'session_new'
      }
    ])
    expect(out).toBe('help - Show help\nsession_new - Start a new session')
  })

  it('static registerBotCommands POSTs to setMyCommands and logs success', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => ''
    })) as unknown as typeof fetch
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await TelegramChannel.registerBotCommands(
      'TOKEN',
      [
        {
          name: 'ping',
          description: 'pong',
          category: 'utility',
          telegramName: 'ping'
        }
      ],
      log
    )

    expect(log.info).toHaveBeenCalledWith(
      'channel.telegram.commands_registered',
      expect.any(Object)
    )
  })

  it('static registerBotCommands logs error on failure', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized'
    })) as unknown as typeof fetch
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await TelegramChannel.registerBotCommands('TOKEN', [], log)
    expect(log.error).toHaveBeenCalledWith(
      'channel.telegram.set_commands_failed',
      expect.any(Object)
    )
  })
})

describe('TelegramChannel — handleMessage with media', () => {
  it('publishes attachments with type=image when a photo is included', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { file_path: 'photos/abc.jpg' } }),
      text: async () => ''
    })) as unknown as typeof fetch

    // Stub the media processor so we don't actually download anything
    vi.spyOn(
      channel as unknown as {
        processMediaMessage: (m: unknown) => Promise<string>
      },
      'processMediaMessage'
    ).mockResolvedValue('image processed')

    await (channel as unknown as { handleMessage: (u: unknown) => Promise<void> }).handleMessage({
      update_id: 1,
      message: {
        message_id: 9,
        chat: { id: 200 },
        from: { id: 100 },
        photo: [
          { file_id: 'p-small', file_unique_id: 'us', width: 50, height: 50, file_size: 1000 },
          { file_id: 'p-large', file_unique_id: 'ul', width: 800, height: 600, file_size: 50000 }
        ]
      }
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.attachments?.[0]?.type).toBe('image')
    expect(inbound.attachments?.[0]?.url).toContain('photos/abc.jpg')
  })

  it('processAudioMessage returns transcription when whisper succeeds', async () => {
    vi.resetModules()
    vi.doMock('../src/audio/whisper.js', () => ({
      downloadToTemp: vi.fn(async () => '/tmp/dl.oga'),
      transcribeAudio: vi.fn(async () => ({ success: true, text: 'how are you' })),
      WHISPER_INSTALL_INSTRUCTIONS: 'install info'
    }))
    const { TelegramChannel: T } = await import('../src/channels/telegram.js')
    const channel = new T(makeConfig(), new MessageBus(), logger)

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { file_path: 'voice/v1.oga' } }),
      text: async () => ''
    })) as unknown as typeof fetch

    const content = await (
      channel as unknown as {
        processAudioMessage: (m: unknown) => Promise<string>
      }
    ).processAudioMessage({
      voice: { file_id: 'v1', file_unique_id: 'vu', duration: 5 }
    })
    expect(content).toContain('how are you')
    vi.doUnmock('../src/audio/whisper.js')
    vi.resetModules()
  })

  it('processAudioMessage returns install instructions when whisper unavailable', async () => {
    vi.resetModules()
    vi.doMock('../src/audio/whisper.js', () => ({
      downloadToTemp: vi.fn(async () => '/tmp/dl.oga'),
      transcribeAudio: vi.fn(async () => ({
        success: false,
        reason: 'no binary'
      })),
      WHISPER_INSTALL_INSTRUCTIONS: 'install info'
    }))
    const { TelegramChannel: T } = await import('../src/channels/telegram.js')
    const channel = new T(makeConfig(), new MessageBus(), logger)

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { file_path: 'voice/v1.oga' } }),
      text: async () => ''
    })) as unknown as typeof fetch

    const content = await (
      channel as unknown as {
        processAudioMessage: (m: unknown) => Promise<string>
      }
    ).processAudioMessage({
      voice: { file_id: 'v1', file_unique_id: 'vu', duration: 5 }
    })
    expect(content).toContain('could not be transcribed')
    expect(content).toContain('install info')
    vi.doUnmock('../src/audio/whisper.js')
    vi.resetModules()
  })

  it('processAudioMessage returns fallback when file path resolution fails', async () => {
    vi.resetModules()
    vi.doMock('../src/audio/whisper.js', () => ({
      downloadToTemp: vi.fn(),
      transcribeAudio: vi.fn(),
      WHISPER_INSTALL_INSTRUCTIONS: ''
    }))
    const { TelegramChannel: T } = await import('../src/channels/telegram.js')
    const channel = new T(makeConfig(), new MessageBus(), logger)

    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => ''
    })) as unknown as typeof fetch

    const content = await (
      channel as unknown as {
        processAudioMessage: (m: unknown) => Promise<string>
      }
    ).processAudioMessage({
      voice: { file_id: 'v1', file_unique_id: 'vu', duration: 5 }
    })
    expect(content).toContain('could not retrieve')
    vi.doUnmock('../src/audio/whisper.js')
    vi.resetModules()
  })

  it('processMediaMessage returns an image-read prompt for photo uploads', async () => {
    vi.resetModules()
    vi.doMock('../src/audio/whisper.js', () => ({
      downloadToTemp: vi.fn(async () => '/tmp/img.jpg'),
      transcribeAudio: vi.fn(),
      WHISPER_INSTALL_INSTRUCTIONS: ''
    }))
    const { TelegramChannel: T } = await import('../src/channels/telegram.js')
    const channel = new T(makeConfig(), new MessageBus(), logger)

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { file_path: 'photos/abc.jpg' } }),
      text: async () => ''
    })) as unknown as typeof fetch

    const content = await (
      channel as unknown as {
        processMediaMessage: (m: unknown) => Promise<string>
      }
    ).processMediaMessage({
      photo: [{ file_id: 'p1', file_unique_id: 'pu', width: 100, height: 100 }],
      caption: 'a photo'
    })
    expect(content).toContain('reading this file')
    expect(content).toContain('a photo')
    vi.doUnmock('../src/audio/whisper.js')
    vi.resetModules()
  })

  it('processMediaMessage returns fallback text when file path lookup fails (with caption)', async () => {
    vi.resetModules()
    vi.doMock('../src/audio/whisper.js', () => ({
      downloadToTemp: vi.fn(),
      transcribeAudio: vi.fn(),
      WHISPER_INSTALL_INSTRUCTIONS: ''
    }))
    const { TelegramChannel: T } = await import('../src/channels/telegram.js')
    const channel = new T(makeConfig(), new MessageBus(), logger)

    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => ''
    })) as unknown as typeof fetch

    const content = await (
      channel as unknown as {
        processMediaMessage: (m: unknown) => Promise<string>
      }
    ).processMediaMessage({
      photo: [{ file_id: 'p1', file_unique_id: 'pu', width: 1, height: 1 }],
      caption: 'with caption'
    })
    expect(content).toContain('with caption')
    expect(content).toContain('could not retrieve')
    vi.doUnmock('../src/audio/whisper.js')
    vi.resetModules()
  })

  it('processMediaMessage returns download-failed when downloadToTemp throws', async () => {
    vi.resetModules()
    vi.doMock('../src/audio/whisper.js', () => ({
      downloadToTemp: vi.fn(async () => {
        throw new Error('download exploded')
      }),
      transcribeAudio: vi.fn(),
      WHISPER_INSTALL_INSTRUCTIONS: ''
    }))
    const { TelegramChannel: T } = await import('../src/channels/telegram.js')
    const channel = new T(makeConfig(), new MessageBus(), logger)

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { file_path: 'photos/p.jpg' } }),
      text: async () => ''
    })) as unknown as typeof fetch

    const content = await (
      channel as unknown as {
        processMediaMessage: (m: unknown) => Promise<string>
      }
    ).processMediaMessage({
      photo: [{ file_id: 'p1', file_unique_id: 'pu', width: 1, height: 1 }]
    })
    expect(content).toContain('download failed')
    vi.doUnmock('../src/audio/whisper.js')
    vi.resetModules()
  })

  it('processAudioMessage returns a generic error message when whisper throws', async () => {
    vi.resetModules()
    vi.doMock('../src/audio/whisper.js', () => ({
      downloadToTemp: vi.fn(async () => '/tmp/dl.oga'),
      transcribeAudio: vi.fn(async () => {
        throw new Error('whisper crashed hard')
      }),
      WHISPER_INSTALL_INSTRUCTIONS: ''
    }))
    const { TelegramChannel: T } = await import('../src/channels/telegram.js')
    const channel = new T(makeConfig(), new MessageBus(), logger)

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { file_path: 'voice/v.oga' } }),
      text: async () => ''
    })) as unknown as typeof fetch

    const content = await (
      channel as unknown as {
        processAudioMessage: (m: unknown) => Promise<string>
      }
    ).processAudioMessage({
      voice: { file_id: 'v1', file_unique_id: 'vu', duration: 5 }
    })
    expect(content).toContain('unexpected error')
    vi.doUnmock('../src/audio/whisper.js')
    vi.resetModules()
  })

  it('processMediaMessage returns a saved-at prompt for non-image documents', async () => {
    vi.resetModules()
    vi.doMock('../src/audio/whisper.js', () => ({
      downloadToTemp: vi.fn(async () => '/tmp/report.pdf'),
      transcribeAudio: vi.fn(),
      WHISPER_INSTALL_INSTRUCTIONS: ''
    }))
    const { TelegramChannel: T } = await import('../src/channels/telegram.js')
    const channel = new T(makeConfig(), new MessageBus(), logger)

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { file_path: 'documents/report.pdf' } }),
      text: async () => ''
    })) as unknown as typeof fetch

    const content = await (
      channel as unknown as {
        processMediaMessage: (m: unknown) => Promise<string>
      }
    ).processMediaMessage({
      document: { file_id: 'd1', file_unique_id: 'du', file_name: 'report.pdf' }
    })
    expect(content).toContain('saved at')
    expect(content).toContain('report.pdf')
    vi.doUnmock('../src/audio/whisper.js')
    vi.resetModules()
  })

  it('publishes a voice transcription via processAudioMessage', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    vi.spyOn(
      channel as unknown as {
        processAudioMessage: (m: unknown) => Promise<string>
      },
      'processAudioMessage'
    ).mockResolvedValue('[Voice message transcription]: hello')

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ ok: true })
    })) as unknown as typeof fetch

    await (channel as unknown as { handleMessage: (u: unknown) => Promise<void> }).handleMessage({
      update_id: 2,
      message: {
        message_id: 9,
        chat: { id: 200 },
        from: { id: 100 },
        voice: { file_id: 'v1', file_unique_id: 'vu', duration: 4 }
      }
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.content).toContain('Voice message transcription')
  })
})

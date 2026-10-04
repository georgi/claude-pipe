import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { MessageBus } from '../src/core/bus.js'
import type { ClaudePipeConfig } from '../src/config/schema.js'
import { TelegramChannel } from '../src/channels/telegram.js'

vi.mock('../src/audio/whisper.js', () => ({
  transcribeAudio: vi.fn(),
  downloadToTemp: vi.fn(),
  WHISPER_INSTALL_INSTRUCTIONS: 'Install whisper-cpp: brew install whisper-cpp'
}))

import { transcribeAudio, downloadToTemp } from '../src/audio/whisper.js'

const mockTranscribeAudio = transcribeAudio as ReturnType<typeof vi.fn>
const mockDownloadToTemp = downloadToTemp as ReturnType<typeof vi.fn>

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
  } as ClaudePipeConfig
}

describe('TelegramChannel voice messages', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('transcribes voice message when whisper-cpp is available', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    // Mock getFile API call
    global.fetch = vi.fn(async (url: string | URL) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('/getFile')) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: { file_path: 'voice/file_0.oga' } })
        }
      }
      // sendChatAction
      return { ok: true, text: async () => '' }
    }) as unknown as typeof fetch

    mockDownloadToTemp.mockResolvedValue('/tmp/claude-pipe-audio/test.oga')
    mockTranscribeAudio.mockResolvedValue({
      success: true,
      text: 'Hello world this is a test'
    })

    await (channel as any).handleMessage({
      update_id: 1,
      message: {
        message_id: 9,
        voice: {
          file_id: 'voice_file_123',
          file_unique_id: 'unique_123',
          duration: 5
        },
        chat: { id: 200 },
        from: { id: 100 }
      }
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.channel).toBe('telegram')
    expect(inbound.chatId).toBe('200')
    expect(inbound.content).toBe('[Voice message transcription]: Hello world this is a test')
    expect(mockDownloadToTemp).toHaveBeenCalledWith(
      'https://api.telegram.org/file/botTEST_TOKEN/voice/file_0.oga',
      '.oga'
    )
    expect(mockTranscribeAudio).toHaveBeenCalledWith('/tmp/claude-pipe-audio/test.oga')
  })

  it('provides install instructions when whisper-cpp is not available', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    global.fetch = vi.fn(async (url: string | URL) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('/getFile')) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: { file_path: 'voice/file_0.oga' } })
        }
      }
      return { ok: true, text: async () => '' }
    }) as unknown as typeof fetch

    mockDownloadToTemp.mockResolvedValue('/tmp/claude-pipe-audio/test.oga')
    mockTranscribeAudio.mockResolvedValue({
      success: false,
      reason: 'whisper-cpp binary not found'
    })

    await (channel as any).handleMessage({
      update_id: 1,
      message: {
        message_id: 10,
        voice: {
          file_id: 'voice_file_456',
          file_unique_id: 'unique_456',
          duration: 10
        },
        chat: { id: 200 },
        from: { id: 100 }
      }
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.content).toContain('voice message (10s)')
    expect(inbound.content).toContain('whisper-cpp binary not found')
    expect(inbound.content).toContain('brew install whisper-cpp')
  })

  it('handles audio messages (not just voice)', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    global.fetch = vi.fn(async (url: string | URL) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('/getFile')) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: { file_path: 'music/file_0.mp3' } })
        }
      }
      return { ok: true, text: async () => '' }
    }) as unknown as typeof fetch

    mockDownloadToTemp.mockResolvedValue('/tmp/claude-pipe-audio/test.mp3')
    mockTranscribeAudio.mockResolvedValue({
      success: true,
      text: 'Audio content here'
    })

    await (channel as any).handleMessage({
      update_id: 1,
      message: {
        message_id: 11,
        audio: {
          file_id: 'audio_file_789',
          file_unique_id: 'unique_789',
          duration: 180,
          title: 'Test Audio',
          mime_type: 'audio/mpeg'
        },
        chat: { id: 200 },
        from: { id: 100 }
      }
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.content).toBe('[Voice message transcription]: Audio content here')
  })

  it('handles getFile API failure gracefully', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    global.fetch = vi.fn(async (url: string | URL) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('/getFile')) {
        return {
          ok: false,
          status: 400,
          text: async () => 'Bad Request'
        }
      }
      return { ok: true, text: async () => '' }
    }) as unknown as typeof fetch

    await (channel as any).handleMessage({
      update_id: 1,
      message: {
        message_id: 12,
        voice: {
          file_id: 'voice_file_bad',
          file_unique_id: 'unique_bad',
          duration: 3
        },
        chat: { id: 200 },
        from: { id: 100 }
      }
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.content).toContain('could not retrieve file from Telegram')
  })

  it('still handles regular text messages normally', async () => {
    const bus = new MessageBus()
    const channel = new TelegramChannel(makeConfig(), bus, logger)

    await (channel as any).handleMessage({
      update_id: 1,
      message: {
        message_id: 13,
        text: 'regular text',
        chat: { id: 200 },
        from: { id: 100 }
      }
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.content).toBe('regular text')
    expect(mockTranscribeAudio).not.toHaveBeenCalled()
  })
})

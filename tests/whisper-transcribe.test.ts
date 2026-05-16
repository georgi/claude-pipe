import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync)
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    unlink: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined)
  }
})

const transcribeMock = vi.fn()
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    audio = {
      transcriptions: {
        create: transcribeMock
      }
    }
  }
}))

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>
const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>

describe('transcribeAudio', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.OPENAI_API_KEY
    delete process.env.WHISPER_CPP_PATH
    delete process.env.WHISPER_CPP_MODEL
  })

  it('uses the OpenAI Whisper API when OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    transcribeMock.mockResolvedValue({ text: 'hello world' })
    mockReadFile.mockResolvedValue(Buffer.from('audio bytes'))

    const { transcribeAudio } = await import('../src/audio/whisper.js')
    const result = await transcribeAudio('/tmp/audio.wav')

    expect(result).toEqual({ success: true, text: 'hello world' })
    expect(transcribeMock).toHaveBeenCalled()
  })

  it('reports failure when OpenAI returns an empty transcription', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    transcribeMock.mockResolvedValue({ text: '   ' })
    mockReadFile.mockResolvedValue(Buffer.from('x'))

    const { transcribeAudio } = await import('../src/audio/whisper.js')
    const result = await transcribeAudio('/tmp/audio.wav')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toContain('empty')
    }
  })

  it('reports failure when OpenAI throws', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    transcribeMock.mockRejectedValue(new Error('quota exceeded'))
    mockReadFile.mockResolvedValue(Buffer.from('x'))

    const { transcribeAudio } = await import('../src/audio/whisper.js')
    const result = await transcribeAudio('/tmp/audio.wav')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toContain('quota exceeded')
    }
  })

  it('falls back to whisper-cpp when no API key, reports binary missing', async () => {
    mockExistsSync.mockReturnValue(false)
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
        cb(new Error('not found'))
      }
    )

    const { transcribeAudio } = await import('../src/audio/whisper.js')
    const result = await transcribeAudio('/tmp/audio.ogg')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toContain('binary not found')
    }
  })

  it('reports model missing when binary is found but model is not', async () => {
    process.env.WHISPER_CPP_PATH = '/usr/bin/whisper-cpp'
    mockExistsSync.mockImplementation((p: string) => p === '/usr/bin/whisper-cpp')

    const { transcribeAudio } = await import('../src/audio/whisper.js')
    const result = await transcribeAudio('/tmp/audio.ogg')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toContain('model not found')
    }
  })

  it('returns the transcription from a successful whisper-cpp run', async () => {
    process.env.WHISPER_CPP_PATH = '/usr/bin/whisper-cpp'
    process.env.WHISPER_CPP_MODEL = '/models/ggml-base.en.bin'
    mockExistsSync.mockImplementation(
      (p: string) =>
        p === '/usr/bin/whisper-cpp' || p === '/models/ggml-base.en.bin'
    )

    let stage = 0
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        optsOrCb: unknown,
        maybeCb?: (err: Error | null, result?: { stdout: string }) => void
      ) => {
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (
          err: Error | null,
          result?: { stdout: string }
        ) => void
        if (args[0] === 'ffmpeg') {
          // which ffmpeg
          cb(null, { stdout: '/usr/bin/ffmpeg\n' })
          return
        }
        if (args.includes('-i')) {
          // ffmpeg conversion
          cb(null, { stdout: '' })
          return
        }
        // whisper-cpp invocation
        stage++
        cb(null, { stdout: '  hello world transcription  \n' })
      }
    )

    const { transcribeAudio } = await import('../src/audio/whisper.js')
    const result = await transcribeAudio('/tmp/audio.ogg')
    expect(result).toEqual({ success: true, text: 'hello world transcription' })
    expect(stage).toBe(1)
  })

  it('reports empty-transcription when whisper-cpp returns nothing', async () => {
    process.env.WHISPER_CPP_PATH = '/usr/bin/whisper-cpp'
    process.env.WHISPER_CPP_MODEL = '/models/ggml-base.en.bin'
    mockExistsSync.mockImplementation(
      (p: string) =>
        p === '/usr/bin/whisper-cpp' || p === '/models/ggml-base.en.bin'
    )

    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        optsOrCb: unknown,
        maybeCb?: (err: Error | null, result?: { stdout: string }) => void
      ) => {
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (
          err: Error | null,
          result?: { stdout: string }
        ) => void
        if (args[0] === 'ffmpeg' || args.includes('-i')) {
          cb(null, { stdout: '' })
          return
        }
        cb(null, { stdout: '   \n' })
      }
    )

    const { transcribeAudio } = await import('../src/audio/whisper.js')
    const result = await transcribeAudio('/tmp/audio.ogg')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toContain('empty')
    }
  })

  it('reports failure when whisper-cpp throws', async () => {
    process.env.WHISPER_CPP_PATH = '/usr/bin/whisper-cpp'
    process.env.WHISPER_CPP_MODEL = '/models/ggml-base.en.bin'
    mockExistsSync.mockImplementation(
      (p: string) =>
        p === '/usr/bin/whisper-cpp' || p === '/models/ggml-base.en.bin'
    )

    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        optsOrCb: unknown,
        maybeCb?: (err: Error | null, result?: { stdout: string }) => void
      ) => {
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (
          err: Error | null,
          result?: { stdout: string }
        ) => void
        if (args[0] === 'ffmpeg' || args.includes('-i')) {
          cb(null, { stdout: '' })
          return
        }
        cb(new Error('whisper crashed'))
      }
    )

    const { transcribeAudio } = await import('../src/audio/whisper.js')
    const result = await transcribeAudio('/tmp/audio.ogg')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toContain('whisper crashed')
    }
  })

  it('reports ffmpeg missing when binary + model are found but ffmpeg is not', async () => {
    process.env.WHISPER_CPP_PATH = '/usr/bin/whisper-cpp'
    process.env.WHISPER_CPP_MODEL = '/models/ggml-base.en.bin'
    mockExistsSync.mockImplementation(
      (p: string) =>
        p === '/usr/bin/whisper-cpp' || p === '/models/ggml-base.en.bin'
    )
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        optsOrCb: unknown,
        maybeCb?: (err: Error | null, result?: { stdout: string }) => void
      ) => {
        const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (
          err: Error | null,
          result?: { stdout: string }
        ) => void
        if (args[0] === 'ffmpeg') {
          cb(new Error('not found'))
        } else {
          cb(null, { stdout: '' })
        }
      }
    )

    const { transcribeAudio } = await import('../src/audio/whisper.js')
    const result = await transcribeAudio('/tmp/audio.ogg')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toContain('ffmpeg')
    }
  })
})

describe('convertToWav', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('invokes ffmpeg with the expected args and returns the wav path', async () => {
    let captured: string[] | undefined
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        cb: (err: Error | null, result: { stdout: string }) => void
      ) => {
        captured = args
        cb(null, { stdout: '' })
      }
    )

    const { convertToWav } = await import('../src/audio/whisper.js')
    const out = await convertToWav('/tmp/clip.ogg')
    expect(out).toBe('/tmp/clip.wav')
    expect(captured).toContain('-i')
    expect(captured).toContain('/tmp/clip.ogg')
    expect(captured).toContain('16000')
  })
})

describe('isFfmpegAvailable', () => {
  it('returns true when which ffmpeg succeeds', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null, result: { stdout: string }) => void) => {
        cb(null, { stdout: '/usr/bin/ffmpeg\n' })
      }
    )

    const { isFfmpegAvailable } = await import('../src/audio/whisper.js')
    expect(await isFfmpegAvailable()).toBe(true)
  })

  it('returns false when which ffmpeg fails', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
        cb(new Error('not found'))
      }
    )

    const { isFfmpegAvailable } = await import('../src/audio/whisper.js')
    expect(await isFfmpegAvailable()).toBe(false)
  })
})

describe('downloadToTemp', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('writes the response body to a file under tmpdir/pi-pipe-audio', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8)
    }))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const { downloadToTemp } = await import('../src/audio/whisper.js')
    const path = await downloadToTemp('https://example.com/file.ogg', '.ogg')

    expect(path).toContain('pi-pipe-audio')
    expect(path.endsWith('.ogg')).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/file.ogg')

    vi.unstubAllGlobals()
  })

  it('throws when the HTTP response is not ok', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      arrayBuffer: async () => new ArrayBuffer(0)
    }))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const { downloadToTemp } = await import('../src/audio/whisper.js')
    await expect(downloadToTemp('https://example.com/x', '.ogg')).rejects.toThrow('HTTP 500')

    vi.unstubAllGlobals()
  })
})

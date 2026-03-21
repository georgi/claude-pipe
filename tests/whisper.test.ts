import { describe, expect, it, vi, beforeEach } from 'vitest'

import {
  findWhisperBinary,
  findWhisperModel,
  isFfmpegAvailable,
  transcribeAudio,
  downloadToTemp,
  WHISPER_INSTALL_INSTRUCTIONS
} from '../src/audio/whisper.js'

import { execFile } from 'node:child_process'

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

import { existsSync } from 'node:fs'

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>

describe('whisper', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env['WHISPER_CPP_PATH']
    delete process.env['WHISPER_CPP_MODEL']
  })

  describe('findWhisperBinary', () => {
    it('returns path from WHISPER_CPP_PATH env var when file exists', async () => {
      mockExistsSync.mockImplementation((p: string) => p === '/custom/whisper')
      process.env['WHISPER_CPP_PATH'] = '/custom/whisper'

      const result = await findWhisperBinary()
      expect(result).toBe('/custom/whisper')
    })

    it('searches PATH for known binary names', async () => {
      mockExistsSync.mockReturnValue(false)
      mockExecFile.mockImplementation(
        (_cmd: string, args: string[], cb: (err: Error | null, result: { stdout: string }) => void) => {
          if (args[0] === 'whisper-cpp') {
            cb(null, { stdout: '/usr/local/bin/whisper-cpp\n' })
          } else {
            cb(new Error('not found'), { stdout: '' })
          }
        }
      )

      const result = await findWhisperBinary()
      expect(result).toBe('/usr/local/bin/whisper-cpp')
    })

    it('returns null when no binary found', async () => {
      mockExistsSync.mockReturnValue(false)
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
          cb(new Error('not found'))
        }
      )

      const result = await findWhisperBinary()
      expect(result).toBeNull()
    })
  })

  describe('findWhisperModel', () => {
    it('returns path from WHISPER_CPP_MODEL env var when file exists', () => {
      mockExistsSync.mockImplementation((p: string) => p === '/models/ggml-base.en.bin')
      process.env['WHISPER_CPP_MODEL'] = '/models/ggml-base.en.bin'

      const result = findWhisperModel()
      expect(result).toBe('/models/ggml-base.en.bin')
    })

    it('returns null when no model found', () => {
      mockExistsSync.mockReturnValue(false)

      const result = findWhisperModel()
      expect(result).toBeNull()
    })
  })

  describe('WHISPER_INSTALL_INSTRUCTIONS', () => {
    it('contains install instructions for whisper', () => {
      expect(WHISPER_INSTALL_INSTRUCTIONS).toContain('brew install whisper-cpp')
      expect(WHISPER_INSTALL_INSTRUCTIONS).toContain('OPENAI_API_KEY')
    })
  })
})

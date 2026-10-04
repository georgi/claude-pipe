import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, unlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'

const execFileAsync = promisify(execFile)

/** Well-known binary names for whisper.cpp in $PATH. */
const WHISPER_BINARY_NAMES = ['whisper-cpp', 'whisper', 'main']

/** Well-known model search directories. */
const MODEL_SEARCH_DIRS = [
  join(process.env['HOME'] ?? '', '.local', 'share', 'whisper-cpp', 'models'),
  join(process.env['HOME'] ?? '', 'whisper.cpp', 'models'),
  '/usr/local/share/whisper-cpp/models',
  '/usr/share/whisper-cpp/models'
]

/** Preferred model file patterns (smallest first for speed). */
const MODEL_FILE_PATTERNS = [
  'ggml-base.en.bin',
  'ggml-base.bin',
  'ggml-small.en.bin',
  'ggml-small.bin',
  'ggml-medium.en.bin',
  'ggml-medium.bin',
  'ggml-large.bin'
]

export interface WhisperResult {
  success: true
  text: string
}

export interface WhisperUnavailable {
  success: false
  reason: string
}

export type TranscribeResult = WhisperResult | WhisperUnavailable

export const WHISPER_INSTALL_INSTRUCTIONS = `The user sent a voice/audio message, but transcription is not available.

To enable voice transcription, either:

**Option 1: Use OpenAI Whisper API**
Set the OPENAI_API_KEY environment variable with your OpenAI API key.

**Option 2: Use whisper.cpp locally**
\`\`\`
brew install whisper-cpp
whisper-cpp-download-ggml-model base.en
\`\`\``

/**
 * Attempts to find the whisper-cpp binary in $PATH or via environment variable.
 */
export async function findWhisperBinary(): Promise<string | null> {
  const envPath = process.env['WHISPER_CPP_PATH']
  if (envPath && existsSync(envPath)) return envPath

  for (const name of WHISPER_BINARY_NAMES) {
    try {
      const { stdout } = await execFileAsync('which', [name])
      const path = stdout.trim()
      if (path) return path
    } catch {
      // not found, try next
    }
  }
  return null
}

/**
 * Attempts to find a whisper.cpp model file.
 */
export function findWhisperModel(): string | null {
  const envModel = process.env['WHISPER_CPP_MODEL']
  if (envModel && existsSync(envModel)) return envModel

  for (const dir of MODEL_SEARCH_DIRS) {
    for (const pattern of MODEL_FILE_PATTERNS) {
      const modelPath = join(dir, pattern)
      if (existsSync(modelPath)) return modelPath
    }
  }
  return null
}

/**
 * Checks whether ffmpeg is available for audio format conversion.
 */
export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync('which', ['ffmpeg'])
    return true
  } catch {
    return false
  }
}

/**
 * Converts an OGG/Opus audio file to 16kHz mono WAV suitable for whisper.cpp.
 * Returns the path to the converted WAV file.
 */
export async function convertToWav(inputPath: string): Promise<string> {
  const wavPath = inputPath.replace(/\.[^.]+$/, '.wav')
  await execFileAsync('ffmpeg', [
    '-i',
    inputPath,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    '-y',
    wavPath
  ])
  return wavPath
}

/**
 * Transcribes an audio file using OpenAI Whisper API.
 *
 * First checks for OPENAI_API_KEY, then falls back to whisper.cpp.
 */
export async function transcribeAudio(audioFilePath: string): Promise<TranscribeResult> {
  const openaiApiKey = process.env['OPENAI_API_KEY']

  if (openaiApiKey) {
    try {
      const openai = new OpenAI({ apiKey: openaiApiKey })

      const audioBuffer = await readFile(audioFilePath)
      const blob = new Blob([audioBuffer])

      const transcript = await openai.audio.transcriptions.create({
        file: new File([blob], 'audio.wav', { type: 'audio/wav' }),
        model: 'whisper-1'
      })

      const text = transcript.text.trim()
      if (!text) {
        return { success: false, reason: 'OpenAI Whisper produced empty transcription' }
      }

      return { success: true, text }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, reason: `OpenAI Whisper transcription failed: ${message}` }
    }
  }

  // Fallback to whisper.cpp
  const binary = await findWhisperBinary()
  if (!binary) {
    return { success: false, reason: 'whisper-cpp binary not found' }
  }

  const model = findWhisperModel()
  if (!model) {
    return { success: false, reason: 'whisper-cpp model not found' }
  }

  const hasFfmpeg = await isFfmpegAvailable()
  if (!hasFfmpeg) {
    return { success: false, reason: 'ffmpeg is required for audio conversion but was not found' }
  }

  let wavPath: string | null = null
  try {
    wavPath = await convertToWav(audioFilePath)

    const WHISPER_TIMEOUT_MS = 120_000

    const { stdout } = await execFileAsync(
      binary,
      ['-m', model, '-f', wavPath, '--no-timestamps'],
      { timeout: WHISPER_TIMEOUT_MS }
    )

    const text = stdout.trim()
    if (!text) {
      return { success: false, reason: 'whisper-cpp produced empty transcription' }
    }

    return { success: true, text }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, reason: `whisper-cpp transcription failed: ${message}` }
  } finally {
    // Clean up temporary WAV file
    if (wavPath) {
      try {
        await unlink(wavPath)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Downloads a file from a URL to a temporary directory.
 * Returns the local file path.
 */
export async function downloadToTemp(url: string, extension: string): Promise<string> {
  const tempDir = join(tmpdir(), 'claude-pipe-audio')
  await mkdir(tempDir, { recursive: true })

  const filePath = join(tempDir, `${randomUUID()}${extension}`)
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to download audio: HTTP ${response.status}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  const { writeFile } = await import('node:fs/promises')
  await writeFile(filePath, buffer)

  return filePath
}

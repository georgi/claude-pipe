import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { TranscriptLogger } from '../src/core/transcript-logger.js'

describe('TranscriptLogger rotation', () => {
  it('rotates log file when exceeding maxBytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-pipe-transcript-rotation-'))
    const path = join(dir, 'transcript.jsonl')

    const logger = new TranscriptLogger({
      enabled: true,
      path,
      maxBytes: 120,
      maxFiles: 2
    })

    await logger.log('conv', { type: 'assistant', text: 'x'.repeat(80) })
    await logger.log('conv', { type: 'assistant', text: 'y'.repeat(80) })

    const rotatedPath = `${path}.1`

    const current = await stat(path)
    const rotated = await stat(rotatedPath)

    expect(current.size).toBeGreaterThan(0)
    expect(rotated.size).toBeGreaterThan(0)

    const rotatedContent = await readFile(rotatedPath, 'utf-8')
    expect(rotatedContent.length).toBeGreaterThan(0)
  })
})

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { TranscriptLogger } from '../src/core/transcript-logger.js'

describe('TranscriptLogger', () => {
  it('does not write file when disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-pipe-transcript-'))
    const path = join(dir, 'transcript.jsonl')

    const logger = new TranscriptLogger({ enabled: false, path })
    await logger.log('conv1', { type: 'assistant', text: 'hello' })

    await expect(readFile(path, 'utf-8')).rejects.toBeTruthy()
  })

  it('writes JSONL entries when enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-pipe-transcript-'))
    const path = join(dir, 'transcript.jsonl')

    const logger = new TranscriptLogger({ enabled: true, path })
    await logger.log('conv1', { type: 'assistant', text: 'hello' })
    await logger.log('conv1', { type: 'result', status: 'success' })

    const content = await readFile(path, 'utf-8')
    const lines = content.trim().split('\n')

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('"conversationKey":"conv1"')
    expect(lines[0]).toContain('"type":"assistant"')
    expect(lines[1]).toContain('"type":"result"')
  })
})

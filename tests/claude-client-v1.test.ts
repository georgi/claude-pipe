import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

type FakeProcess = EventEmitter & {
  stdin: { end: () => void }
  stdout: PassThrough
  stderr: PassThrough
}

function makeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess
  proc.stdin = { end: () => undefined }
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  return proc
}

function makeConfig() {
  return {
    model: 'claude-sonnet-4-5' as const,
    workspace: '/tmp/workspace',
    channels: {
      telegram: { enabled: false, token: '', allowFrom: [] },
      discord: { enabled: false, token: '', allowFrom: [] }
    },
    summaryPrompt: { enabled: true, template: 'Workspace: {{workspace}} Request: {{request}}' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20
  }
}

function pushLine(proc: FakeProcess, frame: Record<string, unknown>): void {
  proc.stdout.write(`${JSON.stringify(frame)}\n`)
}

describe('ClaudeClient (subprocess stream-json)', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('spawns claude, parses stream, and persists session id', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')
    const proc = makeProcess()
    spawnMock.mockReturnValue(proc)

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined)
    }

    const client = new ClaudeClient(
      makeConfig(),
      store as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    )

    const turnPromise = client.runTurn('telegram:1', 'hello', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1'
    })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))

    pushLine(proc, { type: 'system', subtype: 'init', session_id: 'sess-new' })
    pushLine(proc, {
      type: 'assistant',
      session_id: 'sess-new',
      message: { content: [{ type: 'text', text: 'hello from assistant' }] }
    })
    pushLine(proc, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'sess-new'
    })
    proc.stdout.end()
    proc.emit('close', 0, null)

    const result = await turnPromise
    expect(result).toBe('hello from assistant')

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>
    ]
    expect(cmd).toContain('claude')
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('hello')
    expect(options.cwd).toBe('/tmp/workspace')

    expect(store.set).toHaveBeenCalledWith('telegram:1', 'sess-new')
  })

  it('passes resume session id when available', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')
    const proc = makeProcess()
    spawnMock.mockReturnValue(proc)

    const store = {
      get: vi.fn(() => ({ sessionId: 'sess-existing', updatedAt: new Date().toISOString() })),
      set: vi.fn(async () => undefined)
    }

    const client = new ClaudeClient(
      makeConfig(),
      store as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    )

    const turnPromise = client.runTurn('discord:abc', 'continue', {
      workspace: '/tmp/workspace',
      channel: 'discord',
      chatId: 'abc'
    })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))

    pushLine(proc, {
      type: 'assistant',
      session_id: 'sess-existing',
      message: { content: [{ type: 'text', text: 'resumed' }] }
    })
    pushLine(proc, { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-existing' })
    proc.stdout.end()
    proc.emit('close', 0, null)
    await turnPromise

    const [, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(args).toContain('--resume')
    const resumeIndex = args.indexOf('--resume')
    expect(args[resumeIndex + 1]).toBe('sess-existing')
  })

  it('emits tool progress updates via onUpdate callback', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')
    const proc = makeProcess()
    spawnMock.mockReturnValue(proc)

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined)
    }

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const onUpdate = vi.fn(async () => undefined)
    const client = new ClaudeClient(makeConfig(), store as never, logger)

    const turnPromise = client.runTurn('telegram:1', 'web search this', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1',
      onUpdate
    })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))

    pushLine(proc, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tool-1', name: 'WebSearch', input: { query: 'cats' } }]
      }
    })
    pushLine(proc, {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }]
      }
    })
    pushLine(proc, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'final answer' }] }
    })
    pushLine(proc, { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-final' })
    proc.stdout.end()
    proc.emit('close', 0, null)

    const text = await turnPromise
    expect(text).toBe('final answer')
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'turn_started', conversationKey: 'telegram:1' })
    )
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'tool_call_started', toolName: 'WebSearch', toolUseId: 'tool-1' })
    )
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'tool_call_finished', toolName: 'WebSearch', toolUseId: 'tool-1' })
    )
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the Agent SDK before any imports
const queryMock = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock
}))

async function* makeQueryGen(frames: Record<string, unknown>[]) {
  for (const frame of frames) {
    yield frame
  }
}

/** An async-iterable whose first iteration rejects — mimics `query()` throwing. */
function makeThrowingQuery(error: Error): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(error) }
    }
  }
}

function makeConfig() {
  return {
    harness: 'claude' as const,
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

function makeStore() {
  return {
    get: vi.fn(() => undefined),
    set: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined)
  }
}

describe('ClaudeClient (Claude Agent SDK)', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('runs a turn, streams assistant text, and persists session id', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')
    const store = makeStore()

    queryMock.mockReturnValue(
      makeQueryGen([
        {
          type: 'assistant',
          session_id: 'sess-new',
          message: { content: [{ type: 'text', text: 'hello from assistant' }] }
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'hello from assistant',
          session_id: 'sess-new'
        }
      ])
    )

    const client = new ClaudeClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    const result = await client.runTurn('telegram:1', 'hello', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1'
    })

    expect(result).toBe('hello from assistant')
    expect(store.set).toHaveBeenCalledWith('telegram:1', { sessionId: 'sess-new' })

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [callArgs] = queryMock.mock.calls[0] as [
      { prompt: string; options: Record<string, unknown> }
    ]
    expect(callArgs.prompt).toBe('hello')
    expect(callArgs.options.model).toBe('claude-sonnet-4-5')
    expect(callArgs.options.cwd).toBe('/tmp/workspace')
    expect(callArgs.options.permissionMode).toBe('bypassPermissions')
    // System prompt is the shared marker protocol, appended to the preset.
    const sp = callArgs.options.systemPrompt as { append: string }
    expect(sp.append).toContain('[[file:')
    expect(sp.append).toContain('[[memory:')
  })

  it('accumulates multiple text blocks within one assistant message', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')
    const store = makeStore()

    queryMock.mockReturnValue(
      makeQueryGen([
        {
          type: 'assistant',
          session_id: 'sess-multi',
          message: {
            content: [
              { type: 'text', text: 'Part one. ' },
              { type: 'text', text: 'Part two.' }
            ]
          }
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          session_id: 'sess-multi'
        }
      ])
    )

    const updates: Array<{ kind: string; text?: string }> = []
    const onUpdate = vi.fn(async (e: { kind: string; text?: string }) => {
      updates.push(e)
    })
    const client = new ClaudeClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    const result = await client.runTurn('telegram:1', 'go', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1',
      onUpdate
    })

    expect(result).toBe('Part one. Part two.')
    // The final streaming update carries the cumulative text, not just the last block.
    const streamed = updates.filter((u) => u.kind === 'text_streaming')
    expect(streamed.at(-1)?.text).toBe('Part one. Part two.')
  })

  it('passes resume session id when available', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')
    const store = {
      get: vi.fn(() => ({ sessionId: 'sess-existing', updatedAt: new Date().toISOString() })),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    queryMock.mockReturnValue(
      makeQueryGen([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'resumed',
          session_id: 'sess-existing'
        }
      ])
    )

    const client = new ClaudeClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    await client.runTurn('discord:abc', 'continue', {
      workspace: '/tmp/workspace',
      channel: 'discord',
      chatId: 'abc'
    })

    const [callArgs] = queryMock.mock.calls[0] as [{ options: Record<string, unknown> }]
    expect(callArgs.options.resume).toBe('sess-existing')
  })

  it('emits tool progress updates via onUpdate callback', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')
    const store = makeStore()

    queryMock.mockReturnValue(
      makeQueryGen([
        {
          type: 'assistant',
          session_id: 'sess-1',
          message: {
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'WebSearch', input: { query: 'cats' } }
            ]
          }
        },
        {
          type: 'user',
          session_id: 'sess-1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }]
          }
        },
        {
          type: 'assistant',
          session_id: 'sess-1',
          message: { content: [{ type: 'text', text: 'final answer' }] }
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'final answer',
          session_id: 'sess-1'
        }
      ])
    )

    const onUpdate = vi.fn(async () => undefined)
    const client = new ClaudeClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    const text = await client.runTurn('telegram:1', 'web search this', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1',
      onUpdate
    })

    expect(text).toBe('final answer')
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'turn_started', conversationKey: 'telegram:1' })
    )
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'tool_call_started',
        toolName: 'WebSearch',
        toolUseId: 'tool-1'
      })
    )
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'tool_call_finished',
        toolName: 'WebSearch',
        toolUseId: 'tool-1'
      })
    )
  })

  it('returns error message on result with is_error=true', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')
    const store = makeStore()

    queryMock.mockReturnValue(
      makeQueryGen([
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          session_id: 'sess-err'
        }
      ])
    )

    const client = new ClaudeClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    const result = await client.runTurn('telegram:1', 'do something', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1'
    })

    expect(result).toContain('error')
  })

  it('returns "Cancelled." when the query throws an abort error', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')
    const store = makeStore()

    queryMock.mockReturnValue(makeThrowingQuery(new Error('AbortError: operation aborted')))

    const client = new ClaudeClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    const result = await client.runTurn('telegram:1', 'go', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1'
    })
    expect(result).toBe('Cancelled.')
  })

  it('returns an error apology when the query throws a non-abort error', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')
    const store = makeStore()

    queryMock.mockReturnValue(makeThrowingQuery(new Error('rate limit exceeded')))

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const client = new ClaudeClient(makeConfig() as never, store as never, logger)

    const result = await client.runTurn('telegram:1', 'go', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1'
    })
    expect(result).toContain('rate limit')
    expect(logger.error).toHaveBeenCalledWith(
      'claude.turn_failed',
      expect.objectContaining({ error: 'rate limit exceeded' })
    )
  })

  it('setModel changes the model used for the next query', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')
    const store = makeStore()

    queryMock.mockReturnValue(
      makeQueryGen([
        { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' }
      ])
    )

    const client = new ClaudeClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    client.setModel('claude-haiku-4-5')
    await client.runTurn('telegram:1', 'hi', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1'
    })

    const [callArgs] = queryMock.mock.calls[0] as [{ options: Record<string, unknown> }]
    expect(callArgs.options.model).toBe('claude-haiku-4-5')
  })

  it('startNewSession clears the stored session id', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')
    const store = makeStore()

    const client = new ClaudeClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    await client.startNewSession('telegram:1')
    expect(store.clear).toHaveBeenCalledWith('telegram:1')
  })

  it('cancelTurn aborts an in-flight turn and is a no-op otherwise', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')
    const store = makeStore()

    const client = new ClaudeClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    // No in-flight turn — must not throw.
    expect(() => client.cancelTurn('telegram:1')).not.toThrow()
    expect(() => client.closeAll()).not.toThrow()
  })
})

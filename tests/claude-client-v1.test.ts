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

describe('ClaudeClient (Agent SDK)', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('runs a turn, streams assistant text, and persists session id', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

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

    const client = new ClaudeClient(makeConfig(), store as never, {
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
    expect(store.set).toHaveBeenCalledWith('telegram:1', 'sess-new')

    // query called with correct options
    expect(queryMock).toHaveBeenCalledTimes(1)
    const [callArgs] = queryMock.mock.calls[0] as [
      { prompt: string; options: Record<string, unknown> }
    ]
    expect(callArgs.prompt).toBe('hello')
    expect(callArgs.options.model).toBe('claude-sonnet-4-5')
    expect(callArgs.options.cwd).toBe('/tmp/workspace')
    expect(callArgs.options.permissionMode).toBe('bypassPermissions')
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
          type: 'assistant',
          session_id: 'sess-existing',
          message: { content: [{ type: 'text', text: 'resumed' }] }
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'resumed',
          session_id: 'sess-existing'
        }
      ])
    )

    const client = new ClaudeClient(makeConfig(), store as never, {
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

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

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
    const client = new ClaudeClient(makeConfig(), store as never, {
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

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

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

    const client = new ClaudeClient(makeConfig(), store as never, {
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
})

import { describe, expect, it, vi, beforeEach } from 'vitest'

const queryMock = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock
}))

type StreamMessage = Record<string, unknown>

function toAsyncIterable(messages: StreamMessage[]): AsyncIterable<StreamMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message
      }
    }
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
    tools: { execTimeoutSec: 60 },
    summaryPrompt: { enabled: true, template: 'Workspace: {{workspace}} Request: {{request}}' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20
  }
}

describe('ClaudeClient (SDK v1 query)', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('uses query() and persists session id from stream', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')

    queryMock.mockReturnValue(
      toAsyncIterable([
        {
          type: 'assistant',
          session_id: 'sess-new',
          message: {
            content: [{ type: 'text', text: 'hello from assistant' }]
          }
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'sess-new'
        }
      ])
    )

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined)
    }

    const client = new ClaudeClient(
      makeConfig(),
      store as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    )

    const result = await client.runTurn('telegram:1', 'hello', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1'
    })

    expect(result).toBe('hello from assistant')
    expect(queryMock).toHaveBeenCalledTimes(1)

    const call = queryMock.mock.calls[0][0] as {
      prompt: string
      options: Record<string, unknown>
    }

    expect(call.prompt).toBe('hello')
    expect(call.options.model).toBe('claude-sonnet-4-5')
    expect(call.options.cwd).toBe('/tmp/workspace')
    expect(call.options.resume).toBeUndefined()

    expect(store.set).toHaveBeenCalledWith('telegram:1', 'sess-new')
  })

  it('passes resume session id when available', async () => {
    const { ClaudeClient } = await import('../src/core/claude-client.js')

    queryMock.mockReturnValue(
      toAsyncIterable([
        {
          type: 'assistant',
          session_id: 'sess-existing',
          message: {
            content: [{ type: 'text', text: 'resumed' }]
          }
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'sess-existing'
        }
      ])
    )

    const store = {
      get: vi.fn(() => ({ sessionId: 'sess-existing', updatedAt: new Date().toISOString() })),
      set: vi.fn(async () => undefined)
    }

    const client = new ClaudeClient(
      makeConfig(),
      store as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    )

    await client.runTurn('discord:abc', 'continue', {
      workspace: '/tmp/workspace',
      channel: 'discord',
      chatId: 'abc'
    })

    const call = queryMock.mock.calls[0][0] as {
      options: Record<string, unknown>
    }
    expect(call.options.resume).toBe('sess-existing')
  })
})

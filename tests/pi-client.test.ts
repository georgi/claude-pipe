import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSessionEvent, ExtensionAPI } from '@earendil-works/pi-coding-agent'

type FakeSession = {
  sessionFile: string
  subscribe: (cb: (e: AgentSessionEvent) => void) => () => void
  prompt: (text: string) => Promise<void>
  abort: () => Promise<void>
  setModel: ReturnType<typeof vi.fn>
}

const createAgentSessionMock = vi.fn<
  (...args: unknown[]) => Promise<{ session: FakeSession }>
>()
const sessionManagerCreateMock = vi.fn((cwd: string) => ({ kind: 'create', cwd }))
const sessionManagerOpenMock = vi.fn((file: string) => ({ kind: 'open', file }))
const reloadMock = vi.fn(async () => undefined)
let lastLoaderOptions: { extensionFactories?: Array<(pi: ExtensionAPI) => void> } | undefined

class FakeResourceLoader {
  constructor(opts: { extensionFactories?: Array<(pi: ExtensionAPI) => void> }) {
    lastLoaderOptions = opts
  }
  reload = reloadMock
}

vi.mock('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: { create: vi.fn(() => ({ tag: 'auth' })) },
  ModelRegistry: {
    create: vi.fn(() => ({
      find: vi.fn(() => undefined),
      getAll: vi.fn(() => [])
    }))
  },
  DefaultResourceLoader: FakeResourceLoader,
  SessionManager: {
    create: sessionManagerCreateMock,
    open: sessionManagerOpenMock
  },
  getAgentDir: vi.fn(() => '/tmp/.pi/agent'),
  createAgentSession: createAgentSessionMock
}))

vi.mock('@earendil-works/pi-ai', () => ({
  getModel: vi.fn((provider: string, id: string) => ({
    provider,
    id,
    name: id,
    api: 'anthropic-messages',
    baseUrl: 'https://example',
    reasoning: false
  }))
}))

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

function makeFakeSession(
  events: AgentSessionEvent[],
  sessionFile = '/sessions/sess-new.jsonl'
): FakeSession {
  return {
    sessionFile,
    subscribe(cb) {
      // Defer event delivery to mimic streaming during prompt().
      queueMicrotask(() => {
        for (const e of events) cb(e)
      })
      return () => undefined
    },
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined)
  }
}

describe('PiClient (Pi SDK)', () => {
  beforeEach(() => {
    createAgentSessionMock.mockReset()
    sessionManagerCreateMock.mockClear()
    sessionManagerOpenMock.mockClear()
    reloadMock.mockClear()
    lastLoaderOptions = undefined
  })

  it('streams assistant text and persists sessionFile on first turn', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session = makeFakeSession([
      {
        type: 'message_update',
        message: {} as never,
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello ', partial: {} as never }
      },
      {
        type: 'message_update',
        message: {} as never,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'from pi',
          partial: {} as never
        }
      }
    ])
    createAgentSessionMock.mockResolvedValue({ session })

    const client = new PiClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    const result = await client.runTurn('telegram:1', 'hello', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1'
    })

    expect(result).toBe('hello from pi')
    expect(sessionManagerCreateMock).toHaveBeenCalledWith('/tmp/workspace')
    expect(sessionManagerOpenMock).not.toHaveBeenCalled()
    expect(store.set).toHaveBeenCalledWith('telegram:1', '/sessions/sess-new.jsonl')
    expect(session.prompt).toHaveBeenCalledWith('hello')
  })

  it('opens existing session file when one is persisted', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => ({
        sessionFile: '/sessions/sess-existing.jsonl',
        updatedAt: new Date().toISOString()
      })),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session = makeFakeSession(
      [
        {
          type: 'message_update',
          message: {} as never,
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'resumed',
            partial: {} as never
          }
        }
      ],
      '/sessions/sess-existing.jsonl'
    )
    createAgentSessionMock.mockResolvedValue({ session })

    const client = new PiClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    await client.runTurn('discord:abc', 'continue', {
      workspace: '/tmp/workspace',
      channel: 'discord',
      chatId: 'abc'
    })

    expect(sessionManagerOpenMock).toHaveBeenCalledWith('/sessions/sess-existing.jsonl')
    expect(sessionManagerCreateMock).not.toHaveBeenCalled()
    // existing file: don't persist again
    expect(store.set).not.toHaveBeenCalled()
  })

  it('reuses the cached session on subsequent turns', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session = makeFakeSession([
      {
        type: 'message_update',
        message: {} as never,
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'first', partial: {} as never }
      }
    ])
    createAgentSessionMock.mockResolvedValueOnce({ session })

    const client = new PiClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    const ctx = {
      workspace: '/tmp/workspace',
      channel: 'telegram' as const,
      chatId: '1'
    }
    await client.runTurn('telegram:1', 'one', ctx)
    await client.runTurn('telegram:1', 'two', ctx)

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1)
    expect(session.prompt).toHaveBeenNthCalledWith(1, 'one')
    expect(session.prompt).toHaveBeenNthCalledWith(2, 'two')
  })

  it('emits tool progress updates via onUpdate', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session = makeFakeSession([
      {
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'read',
        args: {}
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        toolName: 'read',
        result: { content: [{ type: 'text', text: 'ok' }] },
        isError: false
      },
      {
        type: 'message_update',
        message: {} as never,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'final answer',
          partial: {} as never
        }
      }
    ])
    createAgentSessionMock.mockResolvedValue({ session })

    const onUpdate = vi.fn(async () => undefined)
    const client = new PiClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    const text = await client.runTurn('telegram:1', 'do something', {
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
        toolName: 'read',
        toolUseId: 'tool-1'
      })
    )
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'tool_call_finished',
        toolName: 'read',
        toolUseId: 'tool-1'
      })
    )
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'turn_finished' })
    )
  })

  it('emits tool_call_failed and apology text when tool errors with no response', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session = makeFakeSession([
      {
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'bash',
        args: {}
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        toolName: 'bash',
        result: { error: 'permission denied' },
        isError: true
      }
    ])
    createAgentSessionMock.mockResolvedValue({ session })

    const onUpdate = vi.fn(async () => undefined)
    const client = new PiClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    const result = await client.runTurn('telegram:1', 'run something', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1',
      onUpdate
    })

    expect(result.toLowerCase()).toContain('error')
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'tool_call_failed', toolName: 'bash' })
    )
  })

  it('registers an instructions extension that returns systemPrompt with personality and markers', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session = makeFakeSession([])
    createAgentSessionMock.mockResolvedValue({ session })

    const config = {
      ...makeConfig(),
      personality: { name: 'Piper', traits: 'friendly and concise' }
    }
    const client = new PiClient(config as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    await client.runTurn('telegram:1', 'hi', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1'
    })

    expect(lastLoaderOptions?.extensionFactories).toBeDefined()
    expect(lastLoaderOptions!.extensionFactories!).toHaveLength(1)

    const factory = lastLoaderOptions!.extensionFactories![0]!
    const captured: Array<{ event: string; handler: (e: unknown) => unknown }> = []
    const fakePi = {
      on: (event: string, handler: (e: unknown) => unknown) => {
        captured.push({ event, handler })
      }
    } as unknown as ExtensionAPI
    factory(fakePi)

    expect(captured).toHaveLength(1)
    expect(captured[0]!.event).toBe('before_agent_start')

    const out = captured[0]!.handler({ systemPrompt: 'BASE' }) as { systemPrompt: string }
    expect(out.systemPrompt).toContain('BASE')
    expect(out.systemPrompt).toContain('Piper')
    expect(out.systemPrompt).toContain('friendly and concise')
    expect(out.systemPrompt).toContain('[[file:')
    expect(out.systemPrompt).toContain('[[keyboard:')
    expect(out.systemPrompt).toContain('[[memory:')
  })
})

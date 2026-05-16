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

  it('returns only the BASE_SYSTEM_PROMPT when no personality is configured', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session = makeFakeSession([])
    createAgentSessionMock.mockResolvedValue({ session })

    const client = new PiClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    await client.runTurn('cli:1', 'ping', {
      workspace: '/tmp/workspace',
      channel: 'cli',
      chatId: '1'
    })

    const factory = lastLoaderOptions!.extensionFactories![0]!
    const captured: Array<{ event: string; handler: (e: unknown) => unknown }> = []
    const fakePi = {
      on: (event: string, handler: (e: unknown) => unknown) => {
        captured.push({ event, handler })
      }
    } as unknown as ExtensionAPI
    factory(fakePi)

    const out = captured[0]!.handler({ systemPrompt: '' }) as { systemPrompt: string }
    expect(out.systemPrompt).not.toContain('You are Piper')
    expect(out.systemPrompt).toContain('personal AI assistant')
  })

  it('cancelTurn aborts the cached session for that conversation', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session = makeFakeSession([])
    createAgentSessionMock.mockResolvedValue({ session })

    const client = new PiClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    await client.runTurn('telegram:1', 'hi', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1'
    })

    client.cancelTurn('telegram:1')
    expect(session.abort).toHaveBeenCalled()
  })

  it('cancelTurn is a no-op when no session is cached for the key', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')
    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }
    const client = new PiClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })
    expect(() => client.cancelTurn('unknown')).not.toThrow()
  })

  it('closeAll aborts every cached session and clears state', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const sessionA = makeFakeSession([], '/sessions/a.jsonl')
    const sessionB = makeFakeSession([], '/sessions/b.jsonl')
    createAgentSessionMock
      .mockResolvedValueOnce({ session: sessionA })
      .mockResolvedValueOnce({ session: sessionB })

    const client = new PiClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    await client.runTurn('telegram:1', 'hi', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1'
    })
    await client.runTurn('discord:2', 'hi', {
      workspace: '/tmp/workspace',
      channel: 'discord',
      chatId: '2'
    })

    client.closeAll()
    expect(sessionA.abort).toHaveBeenCalled()
    expect(sessionB.abort).toHaveBeenCalled()

    // A fresh runTurn after closeAll should create a brand-new session
    createAgentSessionMock.mockResolvedValueOnce({ session: makeFakeSession([]) })
    await client.runTurn('telegram:1', 'second', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1'
    })
    expect(createAgentSessionMock).toHaveBeenCalledTimes(3)
  })

  it('startNewSession clears the cached session and store entry', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session = makeFakeSession([])
    createAgentSessionMock.mockResolvedValue({ session })

    const client = new PiClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    await client.runTurn('cli:1', 'hi', {
      workspace: '/tmp/workspace',
      channel: 'cli',
      chatId: '1'
    })
    await client.startNewSession('cli:1')

    expect(store.clear).toHaveBeenCalledWith('cli:1')

    // Next turn should create a new session
    createAgentSessionMock.mockResolvedValueOnce({ session: makeFakeSession([]) })
    await client.runTurn('cli:1', 'again', {
      workspace: '/tmp/workspace',
      channel: 'cli',
      chatId: '1'
    })
    expect(createAgentSessionMock).toHaveBeenCalledTimes(2)
  })

  it('setModel calls session.setModel on each cached session', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session = makeFakeSession([])
    createAgentSessionMock.mockResolvedValue({ session })

    const client = new PiClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    await client.runTurn('telegram:1', 'hi', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1'
    })

    client.setModel('claude-haiku-4-5')
    expect(session.setModel).toHaveBeenCalled()
  })

  it('returns "Cancelled." when session.prompt rejects with an abort error', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session: FakeSession = {
      sessionFile: '/sessions/x.jsonl',
      subscribe: () => () => undefined,
      prompt: vi.fn(async () => {
        throw new Error('Aborted by user')
      }),
      abort: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined)
    }
    createAgentSessionMock.mockResolvedValue({ session })

    const client = new PiClient(makeConfig() as never, store as never, {
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

  it('returns an error apology when session.prompt rejects with a non-abort error', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session: FakeSession = {
      sessionFile: '/sessions/x.jsonl',
      subscribe: () => () => undefined,
      prompt: vi.fn(async () => {
        throw new Error('rate limit exceeded')
      }),
      abort: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined)
    }
    createAgentSessionMock.mockResolvedValue({ session })

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const client = new PiClient(makeConfig() as never, store as never, logger)

    const result = await client.runTurn('telegram:1', 'go', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1'
    })
    expect(result).toContain('rate limit')
    expect(logger.error).toHaveBeenCalledWith(
      'pi.turn_failed',
      expect.objectContaining({ error: 'rate limit exceeded' })
    )
  })

  it('extracts apology text from a tool result with content[].text blocks', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session = makeFakeSession([
      {
        type: 'tool_execution_start',
        toolCallId: 'tool-x',
        toolName: 'bash',
        args: {}
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'tool-x',
        toolName: 'bash',
        result: {
          content: [
            { type: 'text', text: 'first part' },
            { type: 'text', text: 'second part' }
          ]
        },
        isError: true
      }
    ])
    createAgentSessionMock.mockResolvedValue({ session })

    const client = new PiClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    const result = await client.runTurn('cli:1', 'go', {
      workspace: '/tmp/workspace',
      channel: 'cli',
      chatId: '1'
    })
    expect(result.toLowerCase()).toContain('error')
    expect(result).toContain('first part')
  })

  it('extracts apology text from a tool result with a top-level message string', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session = makeFakeSession([
      {
        type: 'tool_execution_start',
        toolCallId: 'tool-y',
        toolName: 'edit',
        args: {}
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'tool-y',
        toolName: 'edit',
        result: { message: 'patch did not apply' },
        isError: true
      }
    ])
    createAgentSessionMock.mockResolvedValue({ session })

    const client = new PiClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    const result = await client.runTurn('cli:1', 'go', {
      workspace: '/tmp/workspace',
      channel: 'cli',
      chatId: '1'
    })
    expect(result).toContain('patch did not apply')
  })

  it('extracts apology text from a string tool result', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session = makeFakeSession([
      {
        type: 'tool_execution_start',
        toolCallId: 't',
        toolName: 'bash',
        args: {}
      },
      {
        type: 'tool_execution_end',
        toolCallId: 't',
        toolName: 'bash',
        result: 'plain string error',
        isError: true
      }
    ])
    createAgentSessionMock.mockResolvedValue({ session })

    const client = new PiClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    const result = await client.runTurn('cli:1', 'go', {
      workspace: '/tmp/workspace',
      channel: 'cli',
      chatId: '1'
    })
    expect(result).toContain('plain string error')
  })

  it('falls back to default message when no response and no error', async () => {
    const { PiClient } = await import('../src/core/pi-client.js')

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const session = makeFakeSession([])
    createAgentSessionMock.mockResolvedValue({ session })

    const client = new PiClient(makeConfig() as never, store as never, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })

    const result = await client.runTurn('cli:1', 'silent', {
      workspace: '/tmp/workspace',
      channel: 'cli',
      chatId: '1'
    })
    expect(result).toBe('I completed processing but have no response to return.')
  })
})

describe('PiClient — resolveModel', () => {
  it('resolves a model from the registry when find() matches', async () => {
    vi.resetModules()
    const find = vi.fn((provider: string, id: string) =>
      provider === 'anthropic' && id === 'claude-sonnet-4-5'
        ? { id, provider, name: id, api: 'anthropic-messages', baseUrl: '', reasoning: false }
        : undefined
    )

    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      AuthStorage: { create: vi.fn(() => ({})) },
      ModelRegistry: {
        create: vi.fn(() => ({
          find,
          getAll: vi.fn(() => [])
        }))
      },
      DefaultResourceLoader: FakeResourceLoader,
      SessionManager: {
        create: vi.fn(() => ({})),
        open: vi.fn(() => ({}))
      },
      getAgentDir: vi.fn(() => '/tmp/.pi/agent'),
      createAgentSession: vi.fn(async () => ({
        session: makeFakeSession([])
      }))
    }))
    vi.doMock('@earendil-works/pi-ai', () => ({ getModel: vi.fn(() => undefined) }))

    const { resolveModel } = await import('../src/core/pi-client.js')
    const { ModelRegistry } = await import('@earendil-works/pi-coding-agent')

    const registry = ModelRegistry.create({} as never)
    const model = resolveModel('claude-sonnet-4-5', registry)
    expect(model.id).toBe('claude-sonnet-4-5')

    vi.resetModules()
  })

  it('parses explicit provider/id syntax via the registry', async () => {
    vi.resetModules()
    const find = vi.fn((provider: string, id: string) =>
      provider === 'openai' && id === 'gpt-5'
        ? { id, provider, name: id, api: 'openai-responses', baseUrl: '', reasoning: false }
        : undefined
    )

    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      AuthStorage: { create: vi.fn(() => ({})) },
      ModelRegistry: { create: vi.fn(() => ({ find, getAll: vi.fn(() => []) })) },
      DefaultResourceLoader: FakeResourceLoader,
      SessionManager: { create: vi.fn(() => ({})), open: vi.fn(() => ({})) },
      getAgentDir: vi.fn(() => '/tmp/.pi/agent'),
      createAgentSession: vi.fn(async () => ({ session: makeFakeSession([]) }))
    }))
    vi.doMock('@earendil-works/pi-ai', () => ({ getModel: vi.fn(() => undefined) }))

    const { resolveModel } = await import('../src/core/pi-client.js')
    const { ModelRegistry } = await import('@earendil-works/pi-coding-agent')

    const registry = ModelRegistry.create({} as never)
    const model = resolveModel('openai/gpt-5', registry)
    expect(model.id).toBe('gpt-5')
    expect(model.provider).toBe('openai')

    vi.resetModules()
  })

  it('falls back to scanning getAll() when no prefix or provider hint matches', async () => {
    vi.resetModules()
    const candidate = {
      id: 'mystery-model-7',
      provider: 'mystery',
      name: 'mm',
      api: 'openai-completions',
      baseUrl: '',
      reasoning: false
    }
    const registry = {
      find: vi.fn(() => undefined),
      getAll: vi.fn(() => [candidate])
    }

    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      AuthStorage: { create: vi.fn(() => ({})) },
      ModelRegistry: { create: vi.fn(() => registry) },
      DefaultResourceLoader: FakeResourceLoader,
      SessionManager: { create: vi.fn(() => ({})), open: vi.fn(() => ({})) },
      getAgentDir: vi.fn(() => '/tmp/.pi/agent'),
      createAgentSession: vi.fn(async () => ({ session: makeFakeSession([]) }))
    }))
    vi.doMock('@earendil-works/pi-ai', () => ({ getModel: vi.fn(() => undefined) }))

    const { resolveModel } = await import('../src/core/pi-client.js')
    const model = resolveModel('mystery-model-7', registry as never)
    expect(model.id).toBe('mystery-model-7')

    vi.resetModules()
  })

  it('throws a friendly error when no resolution path matches', async () => {
    vi.resetModules()
    const registry = {
      find: vi.fn(() => undefined),
      getAll: vi.fn(() => [])
    }

    vi.doMock('@earendil-works/pi-coding-agent', () => ({
      AuthStorage: { create: vi.fn(() => ({})) },
      ModelRegistry: { create: vi.fn(() => registry) },
      DefaultResourceLoader: FakeResourceLoader,
      SessionManager: { create: vi.fn(() => ({})), open: vi.fn(() => ({})) },
      getAgentDir: vi.fn(() => '/tmp/.pi/agent'),
      createAgentSession: vi.fn(async () => ({ session: makeFakeSession([]) }))
    }))
    vi.doMock('@earendil-works/pi-ai', () => ({ getModel: vi.fn(() => undefined) }))

    const { resolveModel } = await import('../src/core/pi-client.js')
    expect(() => resolveModel('totally-unknown-thing', registry as never)).toThrow(/Unknown model/)

    vi.resetModules()
  })
})

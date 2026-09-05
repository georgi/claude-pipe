import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the Codex SDK before any imports
const startThreadMock = vi.fn()
const resumeThreadMock = vi.fn()
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    startThread = startThreadMock
    resumeThread = resumeThreadMock
  }
}))

type Frame = Record<string, unknown>

/**
 * Builds a fake `Thread`. `id` starts null (a fresh thread) unless given, and
 * flips to the `thread.started` id as the SDK's real thread does.
 */
function makeThread(frames: Frame[], id: string | null = null) {
  const thread = {
    id,
    runStreamed: vi.fn(async (_input: unknown, _opts?: { signal?: AbortSignal }) => ({
      events: (async function* () {
        for (const frame of frames) {
          if (frame.type === 'thread.started') thread.id = frame.thread_id as string
          yield frame
        }
      })()
    }))
  }
  return thread
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    harness: 'codex' as const,
    model: 'gpt-5.1-codex',
    workspace: '/tmp/workspace',
    channels: {
      telegram: { enabled: false, token: '', allowFrom: [] },
      discord: { enabled: false, token: '', allowFrom: [] }
    },
    codex: {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      webSearch: true,
      skipGitRepoCheck: true
    },
    summaryPrompt: { enabled: true, template: 'Workspace: {{workspace}} Request: {{request}}' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20,
    ...overrides
  }
}

function makeStore(saved?: { sessionId: string }) {
  return {
    get: vi.fn(() => saved),
    set: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined)
  }
}

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

const context = {
  workspace: '/tmp/workspace',
  channel: 'telegram' as const,
  chatId: '1'
}

describe('describeItem', () => {
  it('maps every tool-bearing item type onto a status line', async () => {
    const { describeItem } = await import('../src/core/codex-client.js')

    expect(
      describeItem({ id: 'w', type: 'web_search', query: 'zod default object' } as never)
    ).toEqual({ toolName: 'WebSearch', toolDetail: 'zod default object' })

    expect(
      describeItem({
        id: 't',
        type: 'todo_list',
        items: [
          { text: 'read the code', completed: true },
          { text: 'write the adapter', completed: false }
        ]
      } as never)
    ).toEqual({ toolName: 'TodoWrite', toolDetail: 'write the adapter' })

    // Every todo done — fall back to a count rather than an empty detail.
    expect(
      describeItem({
        id: 't',
        type: 'todo_list',
        items: [{ text: 'done', completed: true }]
      } as never)
    ).toEqual({ toolName: 'TodoWrite', toolDetail: '1 task' })

    expect(
      describeItem({
        id: 'p',
        type: 'file_change',
        changes: [
          { path: '/ws/src/a.ts', kind: 'update' },
          { path: '/ws/src/b.ts', kind: 'add' }
        ],
        status: 'completed'
      } as never)
    ).toEqual({ toolName: 'Edit', toolDetail: '2 files' })
  })

  it('returns undefined for items that are not tool activity', async () => {
    const { describeItem } = await import('../src/core/codex-client.js')
    expect(describeItem({ id: 'm', type: 'agent_message', text: 'hi' } as never)).toBeUndefined()
    expect(describeItem({ id: 'r', type: 'reasoning', text: 'thinking' } as never)).toBeUndefined()
    expect(describeItem({ id: 'e', type: 'error', message: 'boom' } as never)).toBeUndefined()
  })

  it('condenses a multi-line command into a single status line', async () => {
    const { describeItem } = await import('../src/core/codex-client.js')
    expect(
      describeItem({
        id: 'c',
        type: 'command_execution',
        command: 'npm test \\\n  --silent',
        aggregated_output: '',
        status: 'in_progress'
      } as never)
    ).toEqual({ toolName: 'Bash', toolDetail: 'npm test \\ --silent' })
  })
})

describe('CodexClient (Codex SDK)', () => {
  beforeEach(() => {
    startThreadMock.mockReset()
    resumeThreadMock.mockReset()
  })

  it('runs a turn, returns the agent message, and persists the thread id', async () => {
    const { CodexClient } = await import('../src/core/codex-client.js')
    const store = makeStore()
    const thread = makeThread([
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'hello from codex' }
      },
      { type: 'turn.completed', usage: {} }
    ])
    startThreadMock.mockReturnValue(thread)

    const client = new CodexClient(makeConfig() as never, store as never, logger())
    const result = await client.runTurn('telegram:1', 'hello', context)

    expect(result).toBe('hello from codex')
    expect(store.set).toHaveBeenCalledWith('telegram:1', { sessionId: 'thread-1' })
    expect(startThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.1-codex',
        workingDirectory: '/tmp/workspace',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        skipGitRepoCheck: true
      })
    )
  })

  it('prepends the pi-pipe instructions to the first turn only', async () => {
    const { CodexClient } = await import('../src/core/codex-client.js')
    const thread = makeThread([
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'ok' } }
    ])
    startThreadMock.mockReturnValue(thread)

    const client = new CodexClient(makeConfig() as never, makeStore() as never, logger())
    await client.runTurn('telegram:1', 'first question', context)

    const [firstPrompt] = thread.runStreamed.mock.calls[0] as [string]
    expect(firstPrompt).toContain('personal AI assistant')
    expect(firstPrompt).toContain('[[file:/absolute/path/to/file.ext]]')
    expect(firstPrompt.endsWith('first question')).toBe(true)

    await client.runTurn('telegram:1', 'second question', context)
    const [secondPrompt] = thread.runStreamed.mock.calls[1] as [string]
    expect(secondPrompt).toBe('second question')
  })

  it('resumes a persisted thread without re-sending the instructions', async () => {
    const { CodexClient } = await import('../src/core/codex-client.js')
    const thread = makeThread(
      [{ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'resumed' } }],
      'thread-saved'
    )
    resumeThreadMock.mockReturnValue(thread)

    const client = new CodexClient(
      makeConfig() as never,
      makeStore({ sessionId: 'thread-saved' }) as never,
      logger()
    )
    const result = await client.runTurn('telegram:1', 'again', context)

    expect(result).toBe('resumed')
    expect(startThreadMock).not.toHaveBeenCalled()
    expect(resumeThreadMock).toHaveBeenCalledWith('thread-saved', expect.any(Object))
    expect(thread.runStreamed.mock.calls[0]![0]).toBe('again')
  })

  it('maps command, file-change and MCP items onto tool-call updates', async () => {
    const { CodexClient } = await import('../src/core/codex-client.js')
    const thread = makeThread([
      { type: 'thread.started', thread_id: 't' },
      {
        type: 'item.started',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: '',
          status: 'in_progress'
        }
      },
      {
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: 'ok',
          exit_code: 0,
          status: 'completed'
        }
      },
      {
        type: 'item.completed',
        item: {
          id: 'patch-1',
          type: 'file_change',
          changes: [{ path: '/tmp/workspace/src/a.ts', kind: 'update' }],
          status: 'completed'
        }
      },
      {
        type: 'item.completed',
        item: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'linear',
          tool: 'list_issues',
          arguments: { query: 'open bugs' },
          status: 'failed',
          error: { message: 'server unavailable' }
        }
      },
      { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'done' } }
    ])
    startThreadMock.mockReturnValue(thread)

    const updates: Record<string, unknown>[] = []
    const client = new CodexClient(makeConfig() as never, makeStore() as never, logger())
    await client.runTurn('telegram:1', 'go', {
      ...context,
      onUpdate: async (event) => {
        updates.push(event as unknown as Record<string, unknown>)
      }
    })

    const toolUpdates = updates.filter((u) => String(u.kind).startsWith('tool_call'))
    expect(toolUpdates).toEqual([
      expect.objectContaining({
        kind: 'tool_call_started',
        toolName: 'Bash',
        toolUseId: 'cmd-1',
        toolDetail: 'npm test'
      }),
      expect.objectContaining({
        kind: 'tool_call_finished',
        toolName: 'Bash',
        toolUseId: 'cmd-1'
      }),
      // file_change arrives already completed — the start is synthesized so the
      // channel has a status line to update.
      expect.objectContaining({
        kind: 'tool_call_started',
        toolName: 'Edit',
        toolUseId: 'patch-1',
        toolDetail: 'update src/a.ts'
      }),
      expect.objectContaining({ kind: 'tool_call_finished', toolName: 'Edit' }),
      expect.objectContaining({
        kind: 'tool_call_started',
        toolName: 'mcp__linear__list_issues',
        toolDetail: 'open bugs'
      }),
      expect.objectContaining({ kind: 'tool_call_failed', toolName: 'mcp__linear__list_issues' })
    ])
  })

  it('accumulates multiple agent messages and streams them', async () => {
    const { CodexClient } = await import('../src/core/codex-client.js')
    const thread = makeThread([
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'first part' } },
      { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'second part' } }
    ])
    startThreadMock.mockReturnValue(thread)

    const streamed: string[] = []
    const client = new CodexClient(makeConfig() as never, makeStore() as never, logger())
    const result = await client.runTurn('telegram:1', 'go', {
      ...context,
      onUpdate: async (event) => {
        if (event.kind === 'text_streaming' && event.text) streamed.push(event.text)
      }
    })

    expect(result).toBe('first part\n\nsecond part')
    expect(streamed).toEqual(['first part', 'first part\n\nsecond part'])
  })

  it('replaces an agent message that is updated in place', async () => {
    const { CodexClient } = await import('../src/core/codex-client.js')
    const thread = makeThread([
      { type: 'item.started', item: { id: 'm1', type: 'agent_message', text: 'partial' } },
      { type: 'item.updated', item: { id: 'm1', type: 'agent_message', text: 'partial answer' } },
      {
        type: 'item.completed',
        item: { id: 'm1', type: 'agent_message', text: 'partial answer, complete' }
      }
    ])
    startThreadMock.mockReturnValue(thread)

    const client = new CodexClient(makeConfig() as never, makeStore() as never, logger())
    const result = await client.runTurn('telegram:1', 'go', context)
    expect(result).toBe('partial answer, complete')
  })

  it('surfaces a failed turn as an error message', async () => {
    const { CodexClient } = await import('../src/core/codex-client.js')
    const thread = makeThread([
      { type: 'thread.started', thread_id: 't' },
      { type: 'turn.failed', error: { message: 'model overloaded' } }
    ])
    startThreadMock.mockReturnValue(thread)
    const log = logger()

    const client = new CodexClient(makeConfig() as never, makeStore() as never, log)
    const result = await client.runTurn('telegram:1', 'go', context)

    expect(result).toBe('Sorry, I hit an error: model overloaded')
  })

  it('reports a thrown stream error without losing the turn', async () => {
    const { CodexClient } = await import('../src/core/codex-client.js')
    startThreadMock.mockReturnValue({
      id: null,
      runStreamed: vi.fn(async () => {
        throw new Error('codex CLI not found')
      })
    })
    const log = logger()

    const client = new CodexClient(makeConfig() as never, makeStore() as never, log)
    const result = await client.runTurn('telegram:1', 'go', context)

    expect(result).toBe('Sorry, I hit an error: codex CLI not found')
    expect(log.error).toHaveBeenCalledWith(
      'codex.turn_failed',
      expect.objectContaining({ error: 'codex CLI not found' })
    )
  })

  it('reports a cancelled turn when the stream aborts', async () => {
    const { CodexClient } = await import('../src/core/codex-client.js')
    startThreadMock.mockReturnValue({
      id: null,
      runStreamed: vi.fn(async () => {
        throw new Error('The operation was aborted')
      })
    })

    const client = new CodexClient(makeConfig() as never, makeStore() as never, logger())
    const result = await client.runTurn('telegram:1', 'go', context)
    expect(result).toBe('Cancelled.')
  })

  it('cancelTurn aborts the signal handed to runStreamed', async () => {
    const { CodexClient } = await import('../src/core/codex-client.js')
    let captured: AbortSignal | undefined
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    startThreadMock.mockReturnValue({
      id: null,
      runStreamed: vi.fn(async (_input: unknown, opts?: { signal?: AbortSignal }) => {
        captured = opts?.signal
        return {
          events: (async function* () {
            await gate
            yield { type: 'turn.completed', usage: {} }
          })()
        }
      })
    })

    const client = new CodexClient(makeConfig() as never, makeStore() as never, logger())
    const turn = client.runTurn('telegram:1', 'go', context)
    // Let runStreamed be reached before cancelling.
    await Promise.resolve()
    await Promise.resolve()

    client.cancelTurn('telegram:1')
    expect(captured?.aborted).toBe(true)
    release!()
    await turn
  })

  it('startNewSession drops the cached thread and clears the store', async () => {
    const { CodexClient } = await import('../src/core/codex-client.js')
    const store = makeStore()
    const frames = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'ok' } }
    ]
    startThreadMock.mockReturnValueOnce(makeThread(frames)).mockReturnValueOnce(makeThread(frames))

    const client = new CodexClient(makeConfig() as never, store as never, logger())
    await client.runTurn('telegram:1', 'go', context)

    await client.startNewSession('telegram:1')
    expect(store.clear).toHaveBeenCalledWith('telegram:1')

    // The store is empty now, so the next turn starts a brand-new thread.
    store.get.mockReturnValue(undefined)
    await client.runTurn('telegram:1', 'go again', context)
    expect(startThreadMock).toHaveBeenCalledTimes(2)
  })

  it('setModel rebuilds the thread from its id so history survives', async () => {
    const { CodexClient } = await import('../src/core/codex-client.js')
    const config = makeConfig()
    const thread = makeThread([
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'ok' } }
    ])
    startThreadMock.mockReturnValue(thread)
    resumeThreadMock.mockReturnValue(
      makeThread(
        [{ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'ok' } }],
        'thread-1'
      )
    )

    const client = new CodexClient(config as never, makeStore() as never, logger())
    await client.runTurn('telegram:1', 'go', context)

    client.setModel('gpt-5.1-codex-max')
    expect(config.model).toBe('gpt-5.1-codex-max')

    await client.runTurn('telegram:1', 'go again', context)
    expect(resumeThreadMock).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({ model: 'gpt-5.1-codex-max' })
    )
  })
})

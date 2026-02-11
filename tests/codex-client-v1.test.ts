import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

type FakeProcess = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
}

function makeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  return proc
}

function makeConfig() {
  return {
    model: 'gpt-5-codex',
    workspace: '/tmp/workspace',
    channels: {
      telegram: { enabled: false, token: '', allowFrom: [] },
      discord: { enabled: false, token: '', allowFrom: [] }
    },
    webhook: { enabled: false, port: 3000, host: '0.0.0.0', url: '' },
    summaryPrompt: { enabled: true, template: 'Workspace: {{workspace}} Request: {{request}}' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20,
    heartbeat: { enabled: false, intervalMinutes: 30 }
  }
}

function send(proc: FakeProcess, payload: Record<string, unknown>): void {
  proc.stdout.write(`${JSON.stringify(payload)}\n`)
}

describe('CodexClient (json-rpc app-server)', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    delete process.env.CLAUDEPIPE_CODEX_COMMAND
    delete process.env.CLAUDEPIPE_CODEX_ARGS
    delete process.env.CLAUDEPIPE_CODEX_APPROVAL_POLICY
    delete process.env.CLAUDEPIPE_CODEX_SANDBOX
  })

  it('writes newline-delimited json-rpc requests and handles stream notifications', async () => {
    const { CodexClient } = await import('../src/core/codex-client.js')
    const proc = makeProcess()
    spawnMock.mockReturnValue(proc)

    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined)
    }

    const client = new CodexClient(
      makeConfig(),
      store as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    )

    const writes: string[] = []
    proc.stdin.on('data', (chunk: Buffer | string) => {
      writes.push(chunk.toString())
      const lines = chunk
        .toString()
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
      for (const line of lines) {
        const req = JSON.parse(line) as Record<string, unknown>
        const id = req.id as number
        if (req.method === 'initialize') {
          send(proc, { jsonrpc: '2.0', id, result: { userAgent: 'codex-test' } })
        } else if (req.method === 'thread/start') {
          send(proc, { jsonrpc: '2.0', id, result: { thread: { id: 'thread-1', cwd: '/tmp/workspace' } } })
        } else if (req.method === 'turn/start') {
          send(proc, { jsonrpc: '2.0', id, result: { turn: { id: 'turn-1', status: 'in_progress', error: null } } })
          send(proc, {
            jsonrpc: '2.0',
            method: 'item/started',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: { type: 'commandExecution', id: 'cmd-1', command: 'ls', cwd: '/tmp/workspace', status: 'in_progress', aggregatedOutput: null, exitCode: null }
            }
          })
          send(proc, {
            jsonrpc: '2.0',
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a1', delta: 'hello ' }
          })
          send(proc, {
            jsonrpc: '2.0',
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a1', delta: 'world' }
          })
          send(proc, {
            jsonrpc: '2.0',
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: { type: 'commandExecution', id: 'cmd-1', command: 'ls', cwd: '/tmp/workspace', status: 'completed', aggregatedOutput: 'ok', exitCode: 0 }
            }
          })
          send(proc, {
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } }
          })
          proc.stdout.end()
          proc.emit('close', 0, null)
        }
      }
    })

    const result = await client.runTurn('telegram:1', 'hello', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '1'
    })

    expect(result).toBe('hello world')
    expect(store.set).toHaveBeenCalledWith('telegram:1', 'thread-1')
    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      ['app-server'],
      expect.objectContaining({ cwd: '/tmp/workspace' })
    )
    expect(writes.some((line) => line.endsWith('\n'))).toBe(true)
  })
})

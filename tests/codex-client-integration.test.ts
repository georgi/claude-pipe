import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { CodexClient } from '../src/core/codex-client.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function makeConfig() {
  return {
    model: 'gpt-5-codex',
    workspace: process.cwd(),
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

describe('CodexClient integration (fake app-server subprocess)', () => {
  it('runs a turn and collects structured progress + final text', async () => {
    const oldCommand = process.env.CLAUDEPIPE_CODEX_COMMAND
    const oldArgs = process.env.CLAUDEPIPE_CODEX_ARGS

    process.env.CLAUDEPIPE_CODEX_COMMAND = '/usr/bin/env'
    process.env.CLAUDEPIPE_CODEX_ARGS = JSON.stringify([
      'node',
      path.join(__dirname, 'fixtures', 'fake-codex-app-server.mjs')
    ])

    const updates: Array<{ kind: string; toolName?: string; message: string }> = []
    const store = {
      get: vi.fn(() => undefined),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }

    const client = new CodexClient(
      makeConfig(),
      store as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    )

    let text = ''
    try {
      text = await client.runTurn('telegram:99', 'add logging to this function', {
        workspace: process.cwd(),
        channel: 'telegram',
        chatId: '99',
        onUpdate: (u) => updates.push({ kind: u.kind, toolName: u.toolName, message: u.message })
      })
    } finally {
      if (oldCommand == null) delete process.env.CLAUDEPIPE_CODEX_COMMAND
      else process.env.CLAUDEPIPE_CODEX_COMMAND = oldCommand
      if (oldArgs == null) delete process.env.CLAUDEPIPE_CODEX_ARGS
      else process.env.CLAUDEPIPE_CODEX_ARGS = oldArgs
    }

    expect(text).toContain('Added logging')
    expect(store.set).toHaveBeenCalledWith('telegram:99', 'thread-fake-1')
    expect(
      updates.some((u) => u.kind === 'tool_call_started' && u.toolName === 'apply_patch')
    ).toBe(true)
    expect(
      updates.some((u) => u.kind === 'tool_call_finished' && u.toolName === 'apply_patch')
    ).toBe(true)
  })
})

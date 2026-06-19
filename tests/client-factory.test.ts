import { describe, expect, it, vi } from 'vitest'

import { createModelClient } from '../src/core/client-factory.js'
import { PiClient } from '../src/core/pi-client.js'
import { ClaudeClient } from '../src/core/claude-client.js'
import type { PiPipeConfig } from '../src/config/schema.js'

vi.mock('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: { create: vi.fn(() => ({})) },
  ModelRegistry: { create: vi.fn(() => ({ find: vi.fn(), getAll: vi.fn(() => []) })) },
  DefaultResourceLoader: class {
    reload = vi.fn(async () => undefined)
  },
  SessionManager: { create: vi.fn(), open: vi.fn() },
  getAgentDir: vi.fn(() => '/tmp/.pi/agent'),
  createAgentSession: vi.fn()
}))

vi.mock('@earendil-works/pi-ai', () => ({
  getModel: vi.fn()
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn()
}))

function makeConfig(harness: 'pi' | 'claude'): PiPipeConfig {
  return {
    harness,
    model: 'claude-sonnet-4-5',
    workspace: '/tmp',
    transcriptLog: { enabled: false, path: '/tmp/t.jsonl' }
  } as unknown as PiPipeConfig
}

const store = {
  get: vi.fn(),
  set: vi.fn(),
  clear: vi.fn(),
  entries: vi.fn(() => ({}))
} as never
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

describe('createModelClient', () => {
  it('returns a PiClient when harness is "pi"', () => {
    const client = createModelClient(makeConfig('pi'), store, logger)
    expect(client).toBeInstanceOf(PiClient)
  })

  it('returns a ClaudeClient when harness is "claude"', () => {
    const client = createModelClient(makeConfig('claude'), store, logger)
    expect(client).toBeInstanceOf(ClaudeClient)
  })

  it('defaults to PiClient when harness is unset', () => {
    const config = makeConfig('pi')
    delete (config as { harness?: string }).harness
    const client = createModelClient(config, store, logger)
    expect(client).toBeInstanceOf(PiClient)
  })
})

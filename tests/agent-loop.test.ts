import { describe, expect, it, vi } from 'vitest'

import { AgentLoop } from '../src/core/agent-loop.js'
import { MessageBus } from '../src/core/bus.js'
import type { MicroclawConfig } from '../src/config/schema.js'

function makeConfig(): MicroclawConfig {
  return {
    model: 'claude-sonnet-4-5',
    workspace: '/tmp/workspace',
    channels: {
      telegram: { enabled: false, token: '', allowFrom: [] },
      discord: { enabled: false, token: '', allowFrom: [] }
    },
    tools: { execTimeoutSec: 60, webSearchApiKey: undefined },
    summaryPrompt: { enabled: true, template: 'Workspace: {{workspace}} Request: {{request}}' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20
  }
}

describe('AgentLoop', () => {
  it('consumes inbound and publishes outbound using Claude client', async () => {
    const bus = new MessageBus()
    const claude = {
      runTurn: vi.fn(async () => 'assistant reply'),
      closeAll: vi.fn()
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const loop = new AgentLoop(bus, makeConfig(), claude as never, logger)

    const run = loop.start()
    await bus.publishInbound({
      channel: 'telegram',
      senderId: 'u1',
      chatId: '42',
      content: 'hello',
      timestamp: new Date().toISOString()
    })

    const outbound = await bus.consumeOutbound()
    expect(outbound.channel).toBe('telegram')
    expect(outbound.chatId).toBe('42')
    expect(outbound.content).toBe('assistant reply')

    expect(claude.runTurn).toHaveBeenCalledWith('telegram:42', 'hello', {
      workspace: '/tmp/workspace',
      channel: 'telegram',
      chatId: '42'
    })

    loop.stop()
    await Promise.race([run, new Promise((resolve) => setTimeout(resolve, 25))])
  })
})

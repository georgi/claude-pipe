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
    tools: { execTimeoutSec: 60 },
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
      startNewSession: vi.fn(async () => undefined),
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

    expect(claude.runTurn).toHaveBeenCalledWith(
      'telegram:42',
      'hello',
      expect.objectContaining({
        workspace: '/tmp/workspace',
        channel: 'telegram',
        chatId: '42'
      })
    )

    loop.stop()
    await Promise.race([run, new Promise((resolve) => setTimeout(resolve, 25))])
  })

  it('starts a new session when receiving /new command', async () => {
    const bus = new MessageBus()
    const claude = {
      runTurn: vi.fn(async () => 'assistant reply'),
      startNewSession: vi.fn(async () => undefined),
      closeAll: vi.fn()
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const loop = new AgentLoop(bus, makeConfig(), claude as never, logger)
    const run = loop.start()

    await bus.publishInbound({
      channel: 'telegram',
      senderId: 'u1',
      chatId: '42',
      content: '/new',
      timestamp: new Date().toISOString()
    })

    const outbound = await bus.consumeOutbound()
    expect(outbound.content).toBe('Started a new session for this chat.')
    expect(claude.startNewSession).toHaveBeenCalledWith('telegram:42')
    expect(claude.runTurn).not.toHaveBeenCalled()

    loop.stop()
    await Promise.race([run, new Promise((resolve) => setTimeout(resolve, 25))])
  })

  it('emits tool-call updates as progress metadata for UI channel consumers', async () => {
    const bus = new MessageBus()
    const claude = {
      runTurn: vi.fn(async (_conversationKey: string, _input: string, context: any) => {
        await context.onUpdate({
          kind: 'tool_call_started',
          conversationKey: 'telegram:42',
          message: 'Using tool: WebSearch',
          toolName: 'WebSearch',
          toolUseId: 'tool-1'
        })
        await context.onUpdate({
          kind: 'tool_call_finished',
          conversationKey: 'telegram:42',
          message: 'Tool completed: WebSearch',
          toolName: 'WebSearch',
          toolUseId: 'tool-1'
        })
        return 'assistant reply'
      }),
      startNewSession: vi.fn(async () => undefined),
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

    const progress1 = await bus.consumeOutbound()
    const progress2 = await bus.consumeOutbound()
    const final = await bus.consumeOutbound()

    expect(progress1.metadata).toEqual(
      expect.objectContaining({
        kind: 'progress',
        progressKind: 'tool_call_started',
        toolName: 'WebSearch',
        toolUseId: 'tool-1'
      })
    )
    expect(progress2.metadata).toEqual(
      expect.objectContaining({
        kind: 'progress',
        progressKind: 'tool_call_finished',
        toolName: 'WebSearch',
        toolUseId: 'tool-1'
      })
    )
    expect(final.content).toBe('assistant reply')
    expect(logger.info).toHaveBeenCalledWith(
      'ui.channel.update',
      expect.objectContaining({
        kind: 'tool_call_started',
        toolName: 'WebSearch',
        toolUseId: 'tool-1'
      })
    )

    loop.stop()
    await Promise.race([run, new Promise((resolve) => setTimeout(resolve, 25))])
  })
})

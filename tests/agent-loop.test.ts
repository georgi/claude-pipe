import { describe, expect, it, vi } from 'vitest'

import { AgentLoop } from '../src/core/agent-loop.js'
import { MessageBus } from '../src/core/bus.js'
import { CommandHandler, CommandRegistry, sessionNewCommand } from '../src/commands/index.js'
import type { ClaudePipeConfig } from '../src/config/schema.js'

function makeConfig(): ClaudePipeConfig {
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

    const registry = new CommandRegistry()
    registry.register(sessionNewCommand(claude.startNewSession))
    loop.setCommandHandler(new CommandHandler(registry))

    const run = loop.start()

    await bus.publishInbound({
      channel: 'telegram',
      senderId: 'u1',
      chatId: '42',
      content: '/new',
      timestamp: new Date().toISOString()
    })

    const outbound = await bus.consumeOutbound()
    expect(outbound.content).toContain('New session started')
    expect(claude.startNewSession).toHaveBeenCalledWith('telegram:42')
    expect(claude.runTurn).not.toHaveBeenCalled()

    loop.stop()
    await Promise.race([run, new Promise((resolve) => setTimeout(resolve, 25))])
  })

  it('logs tool-call events but does not send them to the channel', async () => {
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

    // Only the final assistant reply should be sent to the channel
    const final = await bus.consumeOutbound()
    expect(final.content).toBe('assistant reply')

    // Tool call events should still be logged for debugging
    expect(logger.info).toHaveBeenCalledWith(
      'ui.channel.update',
      expect.objectContaining({
        kind: 'tool_call_started',
        toolName: 'WebSearch',
        toolUseId: 'tool-1'
      })
    )
    expect(logger.info).toHaveBeenCalledWith(
      'ui.channel.update',
      expect.objectContaining({
        kind: 'tool_call_finished',
        toolName: 'WebSearch',
        toolUseId: 'tool-1'
      })
    )

    loop.stop()
    await Promise.race([run, new Promise((resolve) => setTimeout(resolve, 25))])
  })

  it('sends tool-call progress via channel manager and edits with final reply', async () => {
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
        return 'final answer'
      }),
      startNewSession: vi.fn(async () => undefined),
      closeAll: vi.fn()
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const sentMessage = { channel: 'telegram' as const, chatId: '42', messageId: '99' }
    const channelManager = {
      sendDirect: vi.fn(async () => sentMessage),
      editMessage: vi.fn(async () => undefined)
    }

    const loop = new AgentLoop(bus, makeConfig(), claude as never, logger)
    loop.setChannelManager(channelManager as any)

    const run = loop.start()
    await bus.publishInbound({
      channel: 'telegram',
      senderId: 'u1',
      chatId: '42',
      content: 'hello',
      timestamp: new Date().toISOString()
    })

    // Wait for processing to complete
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Should have sent the initial tool status message
    expect(channelManager.sendDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'telegram',
        chatId: '42',
        content: '🔧 WebSearch'
      })
    )

    // Should have edited the status message with tool completion, then final reply
    expect(channelManager.editMessage).toHaveBeenCalledWith(sentMessage, '✅ WebSearch')
    expect(channelManager.editMessage).toHaveBeenCalledWith(sentMessage, 'final answer')

    // No outbound via bus when channel manager handles the edit
    const outcome = await Promise.race([
      bus.consumeOutbound().then(() => 'published'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50))
    ])
    expect(outcome).toBe('timeout')

    loop.stop()
    await Promise.race([run, new Promise((resolve) => setTimeout(resolve, 25))])
  })

  it('sends streaming text updates as draft messages and finalises with editMessage', async () => {
    const bus = new MessageBus()
    const claude = {
      runTurn: vi.fn(async (_conversationKey: string, _input: string, context: any) => {
        await context.onUpdate({
          kind: 'text_streaming',
          conversationKey: 'telegram:42',
          message: 'Streaming response...',
          text: 'partial answer'
        })
        return 'full answer'
      }),
      startNewSession: vi.fn(async () => undefined),
      closeAll: vi.fn()
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const draftMessage = { channel: 'telegram' as const, chatId: '42', messageId: '88' }
    const channelManager = {
      sendDirect: vi.fn(async () => undefined),
      sendDraftMessage: vi.fn(async () => draftMessage),
      editMessage: vi.fn(async () => undefined)
    }

    const loop = new AgentLoop(bus, makeConfig(), claude as never, logger)
    loop.setChannelManager(channelManager as any)

    const run = loop.start()
    await bus.publishInbound({
      channel: 'telegram',
      senderId: 'u1',
      chatId: '42',
      content: 'hello',
      timestamp: new Date().toISOString()
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Should have sent partial text as a draft
    expect(channelManager.sendDraftMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'telegram',
        chatId: '42',
        content: 'partial answer'
      })
    )

    // Should have finalised the draft with the full answer
    expect(channelManager.editMessage).toHaveBeenCalledWith(draftMessage, 'full answer')

    // No outbound via bus when channel manager handles the edit
    const outcome = await Promise.race([
      bus.consumeOutbound().then(() => 'published'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50))
    ])
    expect(outcome).toBe('timeout')

    loop.stop()
    await Promise.race([run, new Promise((resolve) => setTimeout(resolve, 25))])
  })

  it('uses streaming draft instead of status message when text streaming follows tool calls', async () => {
    const bus = new MessageBus()
    const claude = {
      runTurn: vi.fn(async (_conversationKey: string, _input: string, context: any) => {
        await context.onUpdate({
          kind: 'tool_call_started',
          conversationKey: 'telegram:42',
          message: 'Using tool: Read',
          toolName: 'Read',
          toolUseId: 'tool-1'
        })
        await context.onUpdate({
          kind: 'text_streaming',
          conversationKey: 'telegram:42',
          message: 'Streaming response...',
          text: 'streaming content'
        })
        return 'final content'
      }),
      startNewSession: vi.fn(async () => undefined),
      closeAll: vi.fn()
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const toolMessage = { channel: 'telegram' as const, chatId: '42', messageId: '55' }
    const channelManager = {
      sendDirect: vi.fn(async () => toolMessage),
      sendDraftMessage: vi.fn(async () => undefined),
      editMessage: vi.fn(async () => undefined)
    }

    const loop = new AgentLoop(bus, makeConfig(), claude as never, logger)
    loop.setChannelManager(channelManager as any)

    const run = loop.start()
    await bus.publishInbound({
      channel: 'telegram',
      senderId: 'u1',
      chatId: '42',
      content: 'hello',
      timestamp: new Date().toISOString()
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // text_streaming should update the existing status message (not send a new draft)
    expect(channelManager.sendDraftMessage).not.toHaveBeenCalled()
    expect(channelManager.editMessage).toHaveBeenCalledWith(toolMessage, 'streaming content')
    // Final answer should also edit the same message
    expect(channelManager.editMessage).toHaveBeenCalledWith(toolMessage, 'final content')

    loop.stop()
    await Promise.race([run, new Promise((resolve) => setTimeout(resolve, 25))])
  })

  it('falls back to bus when channel manager is attached but sendDirect returns void', async () => {
    const bus = new MessageBus()
    const claude = {
      runTurn: vi.fn(async (_conversationKey: string, _input: string, context: any) => {
        await context.onUpdate({
          kind: 'tool_call_started',
          conversationKey: 'telegram:42',
          message: 'Using tool: Read',
          toolName: 'Read',
          toolUseId: 'tool-2'
        })
        return 'result'
      }),
      startNewSession: vi.fn(async () => undefined),
      closeAll: vi.fn()
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const channelManager = {
      sendDirect: vi.fn(async () => undefined),
      sendDraftMessage: vi.fn(async () => undefined),
      editMessage: vi.fn(async () => undefined)
    }

    const loop = new AgentLoop(bus, makeConfig(), claude as never, logger)
    loop.setChannelManager(channelManager as any)

    const run = loop.start()
    await bus.publishInbound({
      channel: 'telegram',
      senderId: 'u1',
      chatId: '42',
      content: 'hello',
      timestamp: new Date().toISOString()
    })

    // Final reply should go through bus since sendDirect returned void (no message to edit)
    const final = await bus.consumeOutbound()
    expect(final.content).toBe('result')

    loop.stop()
    await Promise.race([run, new Promise((resolve) => setTimeout(resolve, 25))])
  })
})

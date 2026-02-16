import { describe, expect, it, vi } from 'vitest'

import { TelegramChannel } from '../src/channels/telegram.js'
import type { ClaudePipeConfig } from '../src/config/schema.js'
import { AgentLoop } from '../src/core/agent-loop.js'
import { MessageBus } from '../src/core/bus.js'

function makeConfig(): ClaudePipeConfig {
  return {
    model: 'claude-sonnet-4-5',
    workspace: '/Users/mg/workspace',
    channels: {
      telegram: { enabled: true, token: 'TKN', allowFrom: ['100'] },
      discord: { enabled: false, token: '', allowFrom: [] }
    },
    tools: { execTimeoutSec: 60 },
    summaryPrompt: { enabled: true, template: 'Workspace: {{workspace}} Request: {{request}}' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20
  }
}

describe('acceptance: telegram summary flow', () => {
  it('receives telegram message and sends model summary back to same chat', async () => {
    const bus = new MessageBus()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const claude = {
      runTurn: vi.fn(async () => 'Workspace summary: file A, file B'),
      closeAll: vi.fn()
    }

    const agent = new AgentLoop(bus, makeConfig(), claude as never, logger)
    const telegram = new TelegramChannel(makeConfig(), bus, logger)

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => ''
    })) as unknown as typeof fetch
    global.fetch = fetchMock

    await (telegram as any).handleMessage({
      update_id: 1,
      message: {
        message_id: 9,
        text: 'summarize files in workspace',
        chat: { id: 200 },
        from: { id: 100 }
      }
    })

    await (agent as any).processOnce()
    const outbound = await bus.consumeOutbound()
    await telegram.send(outbound)

    expect(claude.runTurn).toHaveBeenCalledWith(
      'telegram:200',
      expect.stringContaining('Request: summarize files in workspace'),
      expect.objectContaining({ channel: 'telegram', chatId: '200' }),
      undefined
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // First call: typing indicator
    const [typingUrl, typingInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(typingUrl).toContain('/sendChatAction')
    expect(String(typingInit.body)).toContain('typing')
    // Second call: sendMessage with response
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toContain('/sendMessage')
    expect(String(init.body)).toContain('Workspace summary')
  })
})

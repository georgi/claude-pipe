import { describe, expect, it, vi } from 'vitest'

import { DiscordChannel } from '../src/channels/discord.js'
import type { MicroclawConfig } from '../src/config/schema.js'
import { AgentLoop } from '../src/core/agent-loop.js'
import { MessageBus } from '../src/core/bus.js'

function makeConfig(): MicroclawConfig {
  return {
    model: 'claude-sonnet-4-5',
    workspace: '/Users/mg/workspace',
    channels: {
      telegram: { enabled: false, token: '', allowFrom: [] },
      discord: { enabled: true, token: 'DTKN', allowFrom: ['u1'] }
    },
    tools: { execTimeoutSec: 60, webSearchApiKey: undefined },
    summaryPrompt: { enabled: true, template: 'Workspace: {{workspace}} Request: {{request}}' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20
  }
}

describe('acceptance: discord summary flow', () => {
  it('receives discord message and sends model summary back to same channel', async () => {
    const bus = new MessageBus()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const claude = {
      runTurn: vi.fn(async () => 'Workspace summary: src files and tests'),
      closeAll: vi.fn()
    }

    const agent = new AgentLoop(bus, makeConfig(), claude as never, logger)
    const discord = new DiscordChannel(makeConfig(), bus, logger)

    const send = vi.fn(async () => undefined)
    const fetch = vi.fn(async () => ({ isTextBased: () => true, send }))
    ;(discord as any).client = { channels: { fetch } }

    await (discord as any).onMessage({
      author: { bot: false, id: 'u1' },
      channel: { type: 0 },
      channelId: 'chan-1',
      content: 'summarize files in workspace',
      id: 'msg-1',
      guildId: 'guild-1'
    })

    await (agent as any).processOnce()
    const outbound = await bus.consumeOutbound()
    await discord.send(outbound)

    expect(claude.runTurn).toHaveBeenCalledWith(
      'discord:chan-1',
      expect.stringContaining('Request: summarize files in workspace'),
      expect.objectContaining({ channel: 'discord', chatId: 'chan-1' })
    )

    expect(fetch).toHaveBeenCalledWith('chan-1')
    expect(send).toHaveBeenCalledWith({ content: 'Workspace summary: src files and tests' })
  })
})

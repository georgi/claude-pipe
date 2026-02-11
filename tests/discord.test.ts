import { describe, expect, it, vi } from 'vitest'

import { DiscordChannel } from '../src/channels/discord.js'
import { MessageBus } from '../src/core/bus.js'
import type { ClaudePipeConfig } from '../src/config/schema.js'

function makeConfig(overrides?: { allowChannels?: string[] }): ClaudePipeConfig {
  return {
    model: 'claude-sonnet-4-5',
    workspace: '/tmp/workspace',
    channels: {
      telegram: { enabled: false, token: '', allowFrom: [] },
      discord: {
        enabled: true,
        token: 'discord-token',
        allowFrom: ['u1'],
        allowChannels: overrides?.allowChannels
      }
    },
    tools: { execTimeoutSec: 60 },
    summaryPrompt: { enabled: true, template: 'Workspace: {{workspace}} Request: {{request}}' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20
  }
}

describe('DiscordChannel', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  it('publishes inbound when sender is allowed', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, logger)

    await (channel as any).onMessage({
      author: { bot: false, id: 'u1' },
      channel: { type: 0 },
      channelId: 'c1',
      content: 'hello',
      id: 'm1',
      guildId: 'g1'
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.channel).toBe('discord')
    expect(inbound.senderId).toBe('u1')
    expect(inbound.chatId).toBe('c1')
    expect(inbound.content).toBe('hello')
  })

  it('drops inbound when sender is not allowed', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, logger)

    await (channel as any).onMessage({
      author: { bot: false, id: 'other' },
      channel: { type: 0 },
      channelId: 'c1',
      content: 'blocked',
      id: 'm1',
      guildId: 'g1'
    })

    const outcome = await Promise.race([
      bus.consumeInbound().then(() => 'published'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 20))
    ])

    expect(outcome).toBe('timeout')
  })

  it('drops inbound when channel is not allowed', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig({ allowChannels: ['c-dedicated'] }), bus, logger)

    await (channel as any).onMessage({
      author: { bot: false, id: 'u1' },
      channel: { type: 0 },
      channelId: 'c-other',
      content: 'blocked',
      id: 'm1',
      guildId: 'g1'
    })

    const outcome = await Promise.race([
      bus.consumeInbound().then(() => 'published'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 20))
    ])

    expect(outcome).toBe('timeout')
  })

  it('sends outbound via fetched Discord channel', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, logger)

    const send = vi.fn(async () => undefined)
    const fetch = vi.fn(async () => ({
      isTextBased: () => true,
      send
    }))

    ;(channel as any).client = {
      channels: { fetch }
    }

    await channel.send({ channel: 'discord', chatId: 'c1', content: 'reply' })

    expect(fetch).toHaveBeenCalledWith('c1')
    expect(send).toHaveBeenCalledWith({ content: 'reply' })
  })
})

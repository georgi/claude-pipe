import { describe, expect, it, vi } from 'vitest'

import { DiscordChannel } from '../src/channels/discord.js'
import { MessageBus } from '../src/core/bus.js'
import type { PiPipeConfig } from '../src/config/schema.js'

function makeConfig(overrides?: { allowChannels?: string[] }): PiPipeConfig {
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

    const send = vi.fn(async () => ({ id: 'msg-42' }))
    const fetch = vi.fn(async () => ({
      isTextBased: () => true,
      send
    }))

    ;(channel as any).client = {
      channels: { fetch }
    }

    const sent = await channel.send({ channel: 'discord', chatId: 'c1', content: 'reply' })

    expect(fetch).toHaveBeenCalledWith('c1')
    expect(send).toHaveBeenCalledWith({ content: 'reply' })
    expect(sent).toEqual({ channel: 'discord', chatId: 'c1', messageId: 'msg-42' })
  })

  it('edits a previously sent Discord message', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, logger)

    const edit = vi.fn(async () => undefined)
    const msgFetch = vi.fn(async () => ({ edit }))
    const chFetch = vi.fn(async () => ({
      isTextBased: () => true,
      messages: { fetch: msgFetch }
    }))

    ;(channel as any).client = {
      channels: { fetch: chFetch }
    }

    await channel.editMessage(
      { channel: 'discord', chatId: 'c1', messageId: 'msg-42' },
      'edited content'
    )

    expect(chFetch).toHaveBeenCalledWith('c1')
    expect(msgFetch).toHaveBeenCalledWith('msg-42')
    expect(edit).toHaveBeenCalledWith({ content: 'edited content' })
  })

  it('processes image attachment from Discord message', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, logger)

    const mockAttachments = new Map()
    mockAttachments.set('att1', {
      id: 'att1',
      name: 'screenshot.png',
      url: 'https://cdn.discordapp.com/attachments/123/456/screenshot.png',
      contentType: 'image/png',
      size: 245678
    })

    await (channel as any).onMessage({
      author: { bot: false, id: 'u1' },
      channel: { type: 0 },
      channelId: 'c1',
      content: 'Look at this',
      id: 'm1',
      guildId: 'g1',
      attachments: mockAttachments
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.channel).toBe('discord')
    expect(inbound.content).toBe('Look at this')
    expect(inbound.attachments).toBeDefined()
    expect(inbound.attachments?.length).toBe(1)
    expect(inbound.attachments?.[0].type).toBe('image')
    expect(inbound.attachments?.[0].filename).toBe('screenshot.png')
    expect(inbound.attachments?.[0].url).toBe(
      'https://cdn.discordapp.com/attachments/123/456/screenshot.png'
    )
    expect(inbound.attachments?.[0].mimeType).toBe('image/png')
  })

  it('send() is a no-op when discord channel is disabled', async () => {
    const cfg = makeConfig()
    cfg.channels.discord.enabled = false
    const channel = new DiscordChannel(cfg, new MessageBus(), logger)

    const send = vi.fn()
    ;(channel as unknown as { client: unknown }).client = {
      channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) }
    }

    await channel.send({ channel: 'discord', chatId: 'c1', content: 'x' })
    expect(send).not.toHaveBeenCalled()
  })

  it('start() is a no-op when discord is disabled', async () => {
    const cfg = makeConfig()
    cfg.channels.discord.enabled = false
    const channel = new DiscordChannel(cfg, new MessageBus(), logger)
    await channel.start()
    await channel.stop()
  })

  it('start() warns when token is missing', async () => {
    const cfg = makeConfig()
    cfg.channels.discord.token = ''
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const channel = new DiscordChannel(cfg, new MessageBus(), log)
    await channel.start()
    expect(log.warn).toHaveBeenCalledWith('channel.discord.misconfigured', expect.any(Object))
  })

  it('send() warns when channel is not text-based', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const channel = new DiscordChannel(makeConfig(), new MessageBus(), log)

    ;(channel as unknown as { client: unknown }).client = {
      channels: { fetch: vi.fn(async () => ({ isTextBased: () => false })) }
    }

    await channel.send({ channel: 'discord', chatId: 'c1', content: 'x' })
    expect(log.warn).toHaveBeenCalledWith(
      'channel.discord.send_failed',
      expect.objectContaining({ reason: expect.any(String) })
    )
  })

  it('send() warns when fetched channel is null', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const channel = new DiscordChannel(makeConfig(), new MessageBus(), log)

    ;(channel as unknown as { client: unknown }).client = {
      channels: { fetch: vi.fn(async () => null) }
    }

    await channel.send({ channel: 'discord', chatId: 'c1', content: 'x' })
    expect(log.warn).toHaveBeenCalledWith(
      'channel.discord.send_failed',
      expect.objectContaining({ reason: 'channel not found' })
    )
  })

  it('send() with progress metadata triggers sendTyping', async () => {
    const channel = new DiscordChannel(makeConfig(), new MessageBus(), logger)
    const sendTyping = vi.fn(async () => undefined)

    ;(channel as unknown as { client: unknown }).client = {
      channels: {
        fetch: vi.fn(async () => ({
          isTextBased: () => true,
          send: vi.fn(),
          sendTyping
        }))
      }
    }

    await channel.send({
      channel: 'discord',
      chatId: 'c1',
      content: '',
      metadata: { kind: 'progress' }
    })
    expect(sendTyping).toHaveBeenCalled()
  })

  it('drops bot messages without publishing', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, logger)

    await (channel as unknown as { onMessage: (m: unknown) => Promise<void> }).onMessage({
      author: { bot: true, id: 'other-bot' },
      channel: { type: 0 },
      channelId: 'c1',
      content: 'echo',
      id: 'm1',
      guildId: 'g1'
    })

    const outcome = await Promise.race([
      bus.consumeInbound().then(() => 'published'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 20))
    ])
    expect(outcome).toBe('timeout')
  })

  it('sendMessageDraft is a no-op (Discord has no draft API)', async () => {
    const channel = new DiscordChannel(makeConfig(), new MessageBus(), logger)
    const result = await channel.sendMessageDraft('c1', 'draft')
    expect(result).toBeUndefined()
  })

  it('processes multiple attachments from Discord message', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, logger)

    const mockAttachments = new Map()
    mockAttachments.set('att1', {
      id: 'att1',
      name: 'data.csv',
      url: 'https://cdn.discordapp.com/attachments/123/456/data.csv',
      contentType: 'text/csv',
      size: 12345
    })
    mockAttachments.set('att2', {
      id: 'att2',
      name: 'video.mp4',
      url: 'https://cdn.discordapp.com/attachments/123/456/video.mp4',
      contentType: 'video/mp4',
      size: 5678900
    })

    await (channel as any).onMessage({
      author: { bot: false, id: 'u1' },
      channel: { type: 0 },
      channelId: 'c1',
      content: 'Check these files',
      id: 'm1',
      guildId: 'g1',
      attachments: mockAttachments
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.attachments).toBeDefined()
    expect(inbound.attachments?.length).toBe(2)
    expect(inbound.attachments?.[0].type).toBe('document')
    expect(inbound.attachments?.[0].filename).toBe('data.csv')
    expect(inbound.attachments?.[1].type).toBe('video')
    expect(inbound.attachments?.[1].filename).toBe('video.mp4')
  })
})

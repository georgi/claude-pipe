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
    expect(inbound.attachments?.[0].url).toBe('https://cdn.discordapp.com/attachments/123/456/screenshot.png')
    expect(inbound.attachments?.[0].mimeType).toBe('image/png')
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

  it('sends outbound message with image attachment via Discord', async () => {
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

    await channel.send({
      channel: 'discord',
      chatId: 'c1',
      content: 'Check this image',
      attachments: [{
        type: 'image',
        url: 'https://example.com/image.png',
        filename: 'image.png'
      }]
    })

    expect(fetch).toHaveBeenCalledWith('c1')
    expect(send).toHaveBeenCalledTimes(1)
    
    const sendCall = send.mock.calls[0][0]
    expect(sendCall.content).toBe('Check this image')
    expect(sendCall.files).toBeDefined()
    expect(sendCall.files.length).toBe(1)
    expect(sendCall.files[0].attachment).toBe('https://example.com/image.png')
    expect(sendCall.files[0].name).toBe('image.png')
  })

  it('sends outbound message with multiple attachments via Discord', async () => {
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

    await channel.send({
      channel: 'discord',
      chatId: 'c1',
      content: 'Files attached',
      attachments: [
        { type: 'image', url: 'https://example.com/img1.png', filename: 'img1.png' },
        { type: 'document', url: 'https://example.com/doc.pdf', filename: 'doc.pdf' }
      ]
    })

    expect(send).toHaveBeenCalledTimes(1)
    const sendCall = send.mock.calls[0][0]
    expect(sendCall.files.length).toBe(2)
    expect(sendCall.files[0].attachment).toBe('https://example.com/img1.png')
    expect(sendCall.files[1].attachment).toBe('https://example.com/doc.pdf')
  })

  it('sends outbound attachment without text content via Discord', async () => {
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

    await channel.send({
      channel: 'discord',
      chatId: 'c1',
      content: '',
      attachments: [{
        type: 'video',
        url: 'https://example.com/video.mp4',
        filename: 'video.mp4'
      }]
    })

    expect(send).toHaveBeenCalledTimes(1)
    const sendCall = send.mock.calls[0][0]
    expect(sendCall.content).toBe('')
    expect(sendCall.files.length).toBe(1)
  })
})

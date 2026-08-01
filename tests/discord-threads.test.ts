import { describe, expect, it, vi } from 'vitest'

import { DiscordChannel } from '../src/channels/discord.js'
import { MessageBus } from '../src/core/bus.js'
import type { PiPipeConfig } from '../src/config/schema.js'

const GUILD_TEXT = 0
const PUBLIC_THREAD = 11

function makeConfig(overrides?: {
  allowChannels?: string[]
  useThreads?: boolean
  threadAutoArchiveMinutes?: 60 | 1440 | 4320 | 10080
}): PiPipeConfig {
  return {
    model: 'claude-sonnet-4-5',
    workspace: '/tmp/workspace',
    channels: {
      telegram: { enabled: false, token: '', allowFrom: [] },
      discord: {
        enabled: true,
        token: 'discord-token',
        allowFrom: ['u1'],
        allowChannels: overrides?.allowChannels,
        useThreads: overrides?.useThreads,
        threadAutoArchiveMinutes: overrides?.threadAutoArchiveMinutes
      }
    },
    summaryPrompt: { enabled: true, template: 'Workspace: {{workspace}} Request: {{request}}' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20
  } as unknown as PiPipeConfig
}

/** A guild text channel that supports the history fetch done on mention. */
function guildChannel() {
  return {
    type: GUILD_TEXT,
    isTextBased: () => true,
    messages: { fetch: vi.fn(async () => new Map()) }
  }
}

function threadChannel(parentId: string) {
  return {
    type: PUBLIC_THREAD,
    parentId,
    isTextBased: () => true,
    messages: { fetch: vi.fn(async () => new Map()) }
  }
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

type OnMessage = { onMessage: (m: unknown) => Promise<void> }
type OnInteraction = { onInteraction: (i: unknown) => Promise<void> }

describe('DiscordChannel session threads', () => {
  it('opens a thread for a mention in a text channel and routes the session there', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, logger)
    ;(channel as unknown as { client: unknown }).client = { user: { id: 'bot' } }

    const startThread = vi.fn(async () => ({ id: 'thread-1' }))

    await (channel as unknown as OnMessage).onMessage({
      author: { bot: false, id: 'u1' },
      channel: guildChannel(),
      channelId: 'c1',
      content: '<@bot> plan the migration',
      id: 'm1',
      guildId: 'g1',
      mentions: { has: () => true },
      startThread
    })

    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'plan the migration', autoArchiveDuration: 1440 })
    )

    const inbound = await bus.consumeInbound()
    expect(inbound.chatId).toBe('thread-1')
    expect(inbound.metadata?.parentChannelId).toBe('c1')
  })

  it('honours a configured auto-archive duration', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig({ threadAutoArchiveMinutes: 60 }), bus, logger)
    ;(channel as unknown as { client: unknown }).client = { user: { id: 'bot' } }

    const startThread = vi.fn(async () => ({ id: 'thread-1' }))

    await (channel as unknown as OnMessage).onMessage({
      author: { bot: false, id: 'u1' },
      channel: guildChannel(),
      channelId: 'c1',
      content: 'hi',
      id: 'm1',
      guildId: 'g1',
      mentions: { has: () => true },
      startThread
    })

    expect(startThread).toHaveBeenCalledWith(expect.objectContaining({ autoArchiveDuration: 60 }))
    await bus.consumeInbound()
  })

  it('reuses the thread already attached to the message', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, logger)
    ;(channel as unknown as { client: unknown }).client = { user: { id: 'bot' } }

    const startThread = vi.fn()

    await (channel as unknown as OnMessage).onMessage({
      author: { bot: false, id: 'u1' },
      channel: guildChannel(),
      channelId: 'c1',
      content: 'again',
      id: 'm1',
      guildId: 'g1',
      mentions: { has: () => true },
      hasThread: true,
      thread: { id: 'thread-existing' },
      startThread
    })

    expect(startThread).not.toHaveBeenCalled()
    const inbound = await bus.consumeInbound()
    expect(inbound.chatId).toBe('thread-existing')
  })

  it('falls back to the parent channel when thread creation fails', async () => {
    const bus = new MessageBus()
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const channel = new DiscordChannel(makeConfig(), bus, log)
    ;(channel as unknown as { client: unknown }).client = { user: { id: 'bot' } }

    await (channel as unknown as OnMessage).onMessage({
      author: { bot: false, id: 'u1' },
      channel: guildChannel(),
      channelId: 'c1',
      content: 'hello',
      id: 'm1',
      guildId: 'g1',
      mentions: { has: () => true },
      startThread: vi.fn(async () => {
        throw new Error('Missing Permissions')
      })
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.chatId).toBe('c1')
    expect(inbound.metadata?.parentChannelId).toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(
      'channel.discord.thread_create_failed',
      expect.objectContaining({ chatId: 'c1' })
    )
  })

  it('does not create threads when useThreads is disabled', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig({ useThreads: false }), bus, logger)
    ;(channel as unknown as { client: unknown }).client = { user: { id: 'bot' } }

    const startThread = vi.fn(async () => ({ id: 'thread-1' }))

    await (channel as unknown as OnMessage).onMessage({
      author: { bot: false, id: 'u1' },
      channel: guildChannel(),
      channelId: 'c1',
      content: 'hello',
      id: 'm1',
      guildId: 'g1',
      mentions: { has: () => true },
      startThread
    })

    expect(startThread).not.toHaveBeenCalled()
    const inbound = await bus.consumeInbound()
    expect(inbound.chatId).toBe('c1')
  })

  it('replies to follow-ups in its own thread without a mention', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, logger)
    ;(channel as unknown as { client: unknown }).client = { user: { id: 'bot' } }

    await (channel as unknown as OnMessage).onMessage({
      author: { bot: false, id: 'u1' },
      channel: guildChannel(),
      channelId: 'c1',
      content: '<@bot> start',
      id: 'm1',
      guildId: 'g1',
      mentions: { has: () => true },
      startThread: vi.fn(async () => ({ id: 'thread-1' }))
    })
    await bus.consumeInbound()

    await (channel as unknown as OnMessage).onMessage({
      author: { bot: false, id: 'u1' },
      channel: threadChannel('c1'),
      channelId: 'thread-1',
      content: 'follow-up',
      id: 'm2',
      guildId: 'g1',
      mentions: { has: () => false }
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.chatId).toBe('thread-1')
    expect(inbound.content).toContain('follow-up')
  })

  it('allows thread messages when only the parent channel is allowlisted', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig({ allowChannels: ['c1'] }), bus, logger)
    ;(channel as unknown as { client: unknown }).client = { user: { id: 'bot' } }

    await (channel as unknown as OnMessage).onMessage({
      author: { bot: false, id: 'u1' },
      channel: threadChannel('c1'),
      channelId: 'thread-unknown',
      content: '<@bot> in a thread',
      id: 'm1',
      guildId: 'g1',
      mentions: { has: () => true }
    })

    const inbound = await bus.consumeInbound()
    expect(inbound.chatId).toBe('thread-unknown')
  })

  it('truncates long thread names to Discord limits', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, logger)
    ;(channel as unknown as { client: unknown }).client = { user: { id: 'bot' } }

    const startThread = vi.fn(async () => ({ id: 'thread-1' }))

    await (channel as unknown as OnMessage).onMessage({
      author: { bot: false, id: 'u1' },
      channel: guildChannel(),
      channelId: 'c1',
      content: 'x'.repeat(200),
      id: 'm1',
      guildId: 'g1',
      mentions: { has: () => true },
      startThread
    })

    const name = startThread.mock.calls[0]?.[0]?.name as string
    expect(name.length).toBeLessThanOrEqual(100)
    await bus.consumeInbound()
  })

  it('opens a thread for slash commands and points the reply at it', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, logger)

    const startThread = vi.fn(async () => ({ id: 'thread-9' }))
    const editReply = vi.fn(async () => undefined)
    const interaction = {
      user: { id: 'u1' },
      channelId: 'c1',
      channel: { type: GUILD_TEXT },
      options: { getSubcommand: () => 'new', getString: () => null },
      commandName: 'session',
      deferReply: vi.fn(async () => undefined),
      fetchReply: vi.fn(async () => ({ startThread })),
      editReply,
      id: 'i1',
      guildId: 'g1'
    }

    await (channel as unknown as OnInteraction).onInteraction(interaction)

    expect(startThread).toHaveBeenCalled()
    expect(editReply).toHaveBeenCalledWith({ content: '🧵 Continuing in <#thread-9>' })
    // The answer goes to the thread, so the deferred reply is not reused.
    expect(
      (channel as unknown as { pendingInteractions: Map<string, unknown> }).pendingInteractions.size
    ).toBe(0)

    const inbound = await bus.consumeInbound()
    expect(inbound.chatId).toBe('thread-9')
    expect(inbound.content).toBe('/session_new')
  })

  it('keeps resolving the deferred reply when the slash command thread fails', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, { ...logger, warn: vi.fn() })

    const interaction = {
      user: { id: 'u1' },
      channelId: 'c1',
      channel: { type: GUILD_TEXT },
      options: { getSubcommand: () => null, getString: () => null },
      commandName: 'ping',
      deferReply: vi.fn(async () => undefined),
      fetchReply: vi.fn(async () => {
        throw new Error('Unknown Message')
      }),
      editReply: vi.fn(async () => undefined),
      id: 'i1',
      guildId: 'g1'
    }

    await (channel as unknown as OnInteraction).onInteraction(interaction)

    const inbound = await bus.consumeInbound()
    expect(inbound.chatId).toBe('c1')
    expect(
      (channel as unknown as { pendingInteractions: Map<string, unknown> }).pendingInteractions.get(
        'c1'
      )
    ).toBe(interaction)
  })
})

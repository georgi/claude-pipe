import { describe, expect, it, vi } from 'vitest'

import { DiscordChannel } from '../src/channels/discord.js'
import { MessageBus } from '../src/core/bus.js'
import type { PiPipeConfig } from '../src/config/schema.js'

function makeConfig(): PiPipeConfig {
  return {
    model: 'claude-sonnet-4-5',
    workspace: '/tmp/workspace',
    channels: {
      telegram: { enabled: false, token: '', allowFrom: [] },
      discord: { enabled: true, token: 'd-token', allowFrom: ['u1'] }
    },
    summaryPrompt: { enabled: false, template: '' },
    transcriptLog: { enabled: false, path: '/tmp/t' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20
  } as PiPipeConfig
}

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

describe('DiscordChannel — additional paths', () => {
  it('send() chunks long text and uses the deferred interaction for the first chunk', async () => {
    const channel = new DiscordChannel(makeConfig(), new MessageBus(), log())

    const editReply = vi.fn(async () => ({ id: 'msg-first' }))
    const channelSend = vi.fn(async () => ({ id: 'msg-rest' }))

    ;(
      channel as unknown as {
        pendingInteractions: Map<string, { editReply: typeof editReply }>
        client: unknown
      }
    ).pendingInteractions.set('c1', { editReply } as unknown as never)
    ;(channel as unknown as { client: unknown }).client = {
      channels: {
        fetch: vi.fn(async () => ({ isTextBased: () => true, send: channelSend }))
      }
    }

    const long = 'A'.repeat(5000) // > DISCORD_MESSAGE_MAX (1800) → multi-chunk
    const sent = await channel.send({ channel: 'discord', chatId: 'c1', content: long })

    expect(editReply).toHaveBeenCalled()
    expect(channelSend).toHaveBeenCalled()
    expect(sent?.messageId).toBe('msg-rest')
  })

  it('send() logs error when underlying channel.send throws', async () => {
    const logger = log()
    const channel = new DiscordChannel(makeConfig(), new MessageBus(), logger)

    const send = vi.fn(async () => {
      throw new Error('Discord 5xx')
    })

    ;(channel as unknown as { client: unknown }).client = {
      channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) }
    }

    await channel.send({ channel: 'discord', chatId: 'c1', content: 'oops' })
    expect(logger.error).toHaveBeenCalledWith('channel.discord.send_failed', expect.any(Object))
  })

  it('editMessage logs error when underlying fetch throws', async () => {
    const logger = log()
    const channel = new DiscordChannel(makeConfig(), new MessageBus(), logger)

    ;(channel as unknown as { client: unknown }).client = {
      channels: {
        fetch: vi.fn(async () => ({
          isTextBased: () => true,
          messages: {
            fetch: vi.fn(async () => {
              throw new Error('not found')
            })
          }
        }))
      }
    }

    await channel.editMessage({ channel: 'discord', chatId: 'c1', messageId: 'm1' }, 'new text')
    expect(logger.error).toHaveBeenCalledWith('channel.discord.edit_failed', expect.any(Object))
  })

  it('sendFile sends a Discord attachment and returns SentMessage', async () => {
    const channel = new DiscordChannel(makeConfig(), new MessageBus(), log())
    const send = vi.fn(async () => ({ id: 'file-msg' }))

    ;(channel as unknown as { client: unknown }).client = {
      channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) }
    }

    const result = await channel.sendFile('c1', { filePath: '/tmp/x.png', caption: 'pic' })
    expect(send).toHaveBeenCalledWith({ content: 'pic', files: ['/tmp/x.png'] })
    expect(result?.messageId).toBe('file-msg')
  })

  it('sendFile logs error when send throws', async () => {
    const logger = log()
    const channel = new DiscordChannel(makeConfig(), new MessageBus(), logger)
    const send = vi.fn(async () => {
      throw new Error('upload failed')
    })

    ;(channel as unknown as { client: unknown }).client = {
      channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) }
    }

    await channel.sendFile('c1', { filePath: '/tmp/x.png' })
    expect(logger.error).toHaveBeenCalledWith(
      'channel.discord.send_file_failed',
      expect.any(Object)
    )
  })

  it('sendFile is a no-op when discord is disabled', async () => {
    const cfg = makeConfig()
    cfg.channels.discord.enabled = false
    const channel = new DiscordChannel(cfg, new MessageBus(), log())
    const send = vi.fn()
    ;(channel as unknown as { client: unknown }).client = {
      channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) }
    }
    await channel.sendFile('c1', { filePath: '/tmp/x.png' })
    expect(send).not.toHaveBeenCalled()
  })

  it('onInteraction denies senders not in allowFrom and replies ephemerally', async () => {
    const channel = new DiscordChannel(makeConfig(), new MessageBus(), log())

    const reply = vi.fn(async () => undefined)
    const fakeInteraction = {
      user: { id: 'stranger' },
      channelId: 'c1',
      options: {
        getSubcommand: () => undefined,
        getString: () => null
      },
      commandName: 'ping',
      deferReply: vi.fn(async () => undefined),
      reply,
      id: 'i1',
      guildId: 'g1'
    }

    await (channel as unknown as { onInteraction: (i: unknown) => Promise<void> }).onInteraction(
      fakeInteraction
    )

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }))
  })

  it('onInteraction denies interactions in a non-allowed channel', async () => {
    const cfg = makeConfig()
    cfg.channels.discord.allowChannels = ['c-dedicated']
    const channel = new DiscordChannel(cfg, new MessageBus(), log())

    const reply = vi.fn(async () => undefined)
    const fakeInteraction = {
      user: { id: 'u1' },
      channelId: 'c-other',
      options: { getSubcommand: () => undefined, getString: () => null },
      commandName: 'ping',
      deferReply: vi.fn(async () => undefined),
      reply,
      id: 'i1',
      guildId: 'g1'
    }

    await (channel as unknown as { onInteraction: (i: unknown) => Promise<void> }).onInteraction(
      fakeInteraction
    )
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('not authorised') })
    )
  })

  it('onInteraction publishes a /command_subcommand inbound for allowed senders', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, log())

    const deferReply = vi.fn(async () => undefined)
    const fakeInteraction = {
      user: { id: 'u1' },
      channelId: 'c1',
      options: {
        getSubcommand: () => 'new',
        getString: () => null
      },
      commandName: 'session',
      deferReply,
      reply: vi.fn(),
      id: 'i1',
      guildId: 'g1'
    }

    await (channel as unknown as { onInteraction: (i: unknown) => Promise<void> }).onInteraction(
      fakeInteraction
    )

    const inbound = await bus.consumeInbound()
    expect(inbound.content).toBe('/session_new')
    expect(deferReply).toHaveBeenCalled()
  })

  it('onInteraction appends the prompt string when provided', async () => {
    const bus = new MessageBus()
    const channel = new DiscordChannel(makeConfig(), bus, log())

    const fakeInteraction = {
      user: { id: 'u1' },
      channelId: 'c1',
      options: {
        getSubcommand: () => 'ask',
        getString: () => 'what is 2+2'
      },
      commandName: 'pi',
      deferReply: vi.fn(async () => undefined),
      reply: vi.fn(),
      id: 'i1',
      guildId: 'g1'
    }

    await (channel as unknown as { onInteraction: (i: unknown) => Promise<void> }).onInteraction(
      fakeInteraction
    )

    const inbound = await bus.consumeInbound()
    expect(inbound.content).toBe('/pi_ask what is 2+2')
  })

  it('registerSlashCommands groups subcommands and sends a REST.put', async () => {
    const put = vi.fn(async () => undefined)
    const setToken = vi.fn(() => ({ put }))

    vi.doMock('discord.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('discord.js')>()
      return {
        ...actual,
        REST: class {
          setToken = setToken
        },
        Routes: {
          applicationCommands: vi.fn((appId: string) => `/applications/${appId}/commands`)
        }
      }
    })

    vi.resetModules()
    const { DiscordChannel: FreshDiscordChannel } = await import('../src/channels/discord.js')
    const logger = log()

    await FreshDiscordChannel.registerSlashCommands(
      'tok',
      'app-123',
      [
        {
          name: 'help',
          description: 'show help',
          category: 'utility',
          telegramName: 'help'
        },
        // A command whose name already includes the group prefix — Discord's
        // subcommand name should be the bare suffix, not the double-prefixed
        // value (e.g. `/pi ask`, not `/pi pi_ask`).
        {
          name: 'pi_ask',
          description: 'send a prompt',
          category: 'pi',
          telegramName: 'pi_ask',
          group: 'pi'
        }
      ],
      logger
    )

    expect(setToken).toHaveBeenCalledWith('tok')
    expect(put).toHaveBeenCalledTimes(1)

    const [, putBody] = put.mock.calls[0] as [string, { body: Array<Record<string, unknown>> }]
    const body = putBody.body
    const piGroup = body.find((entry) => entry.name === 'pi') as
      | { name: string; options: Array<{ name: string }> }
      | undefined
    expect(piGroup).toBeDefined()
    expect(piGroup?.options.map((o) => o.name)).toEqual(['ask'])

    expect(logger.info).toHaveBeenCalledWith(
      'channel.discord.slash_commands_registered',
      expect.any(Object)
    )

    vi.doUnmock('discord.js')
    vi.resetModules()
  })
})

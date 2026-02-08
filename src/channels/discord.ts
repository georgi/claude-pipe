import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message
} from 'discord.js'

import type { MicroclawConfig } from '../config/schema.js'
import { MessageBus } from '../core/bus.js'
import { retry } from '../core/retry.js'
import { chunkText } from '../core/text-chunk.js'
import type { InboundMessage, Logger, OutboundMessage } from '../core/types.js'
import { isSenderAllowed, type Channel } from './base.js'

const DISCORD_MESSAGE_MAX = 1800
const SEND_RETRY_ATTEMPTS = 2
const SEND_RETRY_BACKOFF_MS = 50

/**
 * Discord adapter using discord.js gateway client + channel send API.
 */
export class DiscordChannel implements Channel {
  readonly name = 'discord' as const
  private client: Client | null = null

  constructor(
    private readonly config: MicroclawConfig,
    private readonly bus: MessageBus,
    private readonly logger: Logger
  ) {}

  /** Initializes and logs in the Discord bot when enabled. */
  async start(): Promise<void> {
    if (!this.config.channels.discord.enabled) return
    if (!this.config.channels.discord.token) {
      this.logger.warn('channel.discord.misconfigured', { reason: 'missing token' })
      return
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Channel]
    })

    this.client.on('ready', () => {
      this.logger.info('channel.discord.ready', {
        user: this.client?.user?.tag ?? 'unknown'
      })
    })

    this.client.on('messageCreate', async (message) => {
      await this.onMessage(message)
    })

    this.client.on('error', (error) => {
      this.logger.error('channel.discord.error', { error: error.message })
    })

    await this.client.login(this.config.channels.discord.token)
    this.logger.info('channel.discord.start')
  }

  /** Logs out and destroys the Discord client. */
  async stop(): Promise<void> {
    if (!this.client) return
    await this.client.destroy()
    this.client = null
    this.logger.info('channel.discord.stop')
  }

  /** Sends a text message to a Discord channel by ID. */
  async send(message: OutboundMessage): Promise<void> {
    if (!this.client || !this.config.channels.discord.enabled) return

    const channel = await this.client.channels.fetch(message.chatId)
    if (!channel) {
      this.logger.warn('channel.discord.send_failed', {
        reason: 'channel not found',
        chatId: message.chatId
      })
      return
    }

    if (!channel.isTextBased() || !('send' in channel) || typeof channel.send !== 'function') {
      this.logger.warn('channel.discord.send_failed', {
        reason: 'channel is not send-capable text channel',
        chatId: message.chatId
      })
      return
    }

    if (message.metadata?.kind === 'progress') {
      if ('sendTyping' in channel && typeof channel.sendTyping === 'function') {
        try {
          await retry(
            async () => {
              await channel.sendTyping()
            },
            {
              attempts: SEND_RETRY_ATTEMPTS,
              backoffMs: SEND_RETRY_BACKOFF_MS
            }
          )
        } catch (error) {
          this.logger.error('channel.discord.typing_failed', {
            chatId: message.chatId,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
      return
    }

    for (const part of chunkText(message.content, DISCORD_MESSAGE_MAX)) {
      try {
        await retry(
          async () => {
            await channel.send({ content: part })
          },
          {
            attempts: SEND_RETRY_ATTEMPTS,
            backoffMs: SEND_RETRY_BACKOFF_MS
          }
        )
      } catch (error) {
        this.logger.error('channel.discord.send_failed', {
          chatId: message.chatId,
          error: error instanceof Error ? error.message : String(error)
        })
        break
      }
    }
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return

    const senderId = message.author.id
    if (!isSenderAllowed(senderId, this.config.channels.discord.allowFrom)) {
      this.logger.warn('channel.discord.denied', { senderId })
      return
    }

    if (
      message.channel.type !== ChannelType.GuildText &&
      message.channel.type !== ChannelType.PublicThread &&
      message.channel.type !== ChannelType.PrivateThread &&
      message.channel.type !== ChannelType.DM
    ) {
      return
    }

    const inbound: InboundMessage = {
      channel: 'discord',
      senderId,
      chatId: message.channelId,
      content: message.content?.trim() || '[empty message]',
      timestamp: new Date().toISOString(),
      metadata: {
        messageId: message.id,
        guildId: message.guildId ?? undefined
      }
    }

    await this.bus.publishInbound(inbound)
  }
}

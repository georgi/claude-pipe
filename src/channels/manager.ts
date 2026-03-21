import type { ClaudePipeConfig } from '../config/schema.js'
import { MessageBus } from '../core/bus.js'
import type { FileAttachment, Logger, OutboundMessage, SentMessage } from '../core/types.js'
import type { Channel } from './base.js'
import { CliChannel } from './cli.js'
import { DiscordChannel } from './discord.js'
import { TelegramChannel } from './telegram.js'

/**
 * Owns channel adapter lifecycle and outbound message dispatching.
 */
export class ChannelManager {
  private readonly channels: Channel[]
  private readonly telegram: TelegramChannel
  private readonly discord: DiscordChannel
  private readonly cli: CliChannel
  private dispatcherRunning = false

  constructor(
    private readonly config: ClaudePipeConfig,
    private readonly bus: MessageBus,
    private readonly logger: Logger
  ) {
    this.telegram = new TelegramChannel(config, bus, logger)
    this.discord = new DiscordChannel(config, bus, logger)
    this.cli = new CliChannel(config, bus, logger)
    this.channels = [this.telegram, this.discord, this.cli]
  }

  /** Starts all adapters and launches outbound dispatcher. */
  async startAll(): Promise<void> {
    for (const channel of this.channels) {
      await channel.start()
    }

    this.dispatcherRunning = true
    void this.dispatchOutbound()
  }

  /** Stops outbound dispatch and all channel adapters. */
  async stopAll(): Promise<void> {
    this.dispatcherRunning = false

    for (const channel of this.channels) {
      await channel.stop()
    }
  }

  /** Sends a message directly through the appropriate channel adapter. */
  async sendDirect(message: OutboundMessage): Promise<SentMessage | void> {
    const channel = this.channels.find((ch) => ch.name === message.channel)
    if (!channel) {
      this.logger.warn('channel.unknown', { channel: message.channel })
      return
    }
    return channel.send(message)
  }

  /** Edits a previously sent message through the appropriate channel adapter. */
  async editMessage(sent: SentMessage, newContent: string): Promise<void> {
    const channel = this.channels.find((ch) => ch.name === sent.channel)
    if (!channel) {
      this.logger.warn('channel.unknown', { channel: sent.channel })
      return
    }
    await channel.editMessage(sent, newContent)
  }

  /** Sends a streaming draft message through the appropriate channel adapter. */
  async sendDraftMessage(message: OutboundMessage): Promise<SentMessage | void> {
    const channel = this.channels.find((ch) => ch.name === message.channel)
    if (!channel) {
      this.logger.warn('channel.unknown', { channel: message.channel })
      return
    }
    return channel.sendMessageDraft(message.chatId, message.content)
  }

  /** Sends a file through the appropriate channel adapter. */
  async sendFile(channelName: string, chatId: string, attachment: FileAttachment): Promise<SentMessage | void> {
    const channel = this.channels.find((ch) => ch.name === channelName)
    if (!channel) {
      this.logger.warn('channel.unknown', { channel: channelName })
      return
    }
    return channel.sendFile(chatId, attachment)
  }

  private async dispatchOutbound(): Promise<void> {
    while (this.dispatcherRunning) {
      const msg = await this.bus.consumeOutbound()
      const channel = this.channels.find((ch) => ch.name === msg.channel)

      if (!channel) {
        this.logger.warn('channel.unknown', { channel: msg.channel })
        continue
      }

      await channel.send(msg)
    }
  }
}

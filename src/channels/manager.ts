import type { ClaudePipeConfig } from '../config/schema.js'
import { MessageBus } from '../core/bus.js'
import type { Logger } from '../core/types.js'
import type { Channel } from './base.js'
import { CliChannel } from './cli.js'
import { DiscordChannel } from './discord.js'
import { TelegramChannel } from './telegram.js'
import { WebhookServer } from './webhook-server.js'

/**
 * Owns channel adapter lifecycle and outbound message dispatching.
 */
export class ChannelManager {
  private readonly channels: Channel[]
  private readonly telegram: TelegramChannel
  private readonly discord: DiscordChannel
  private readonly cli: CliChannel
  private webhookServer: WebhookServer | null = null
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
    // Start webhook server if enabled
    if (this.config.webhook.enabled) {
      this.webhookServer = new WebhookServer(
        this.config.webhook.port,
        this.config.webhook.host,
        this.logger
      )

      await this.telegram.registerWebhook(this.webhookServer)
      await this.discord.registerWebhook(this.webhookServer)
      await this.webhookServer.start()
    }

    for (const channel of this.channels) {
      await channel.start()
    }

    this.dispatcherRunning = true
    void this.dispatchOutbound()
  }

  /** Stops outbound dispatch, webhook server, and all channel adapters. */
  async stopAll(): Promise<void> {
    this.dispatcherRunning = false

    for (const channel of this.channels) {
      await channel.stop()
    }

    if (this.webhookServer) {
      await this.webhookServer.stop()
      this.webhookServer = null
    }
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

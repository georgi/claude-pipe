import type { ClaudePipeConfig } from '../config/schema.js'
import { MessageBus } from './bus.js'
import type { Logger } from './types.js'

/**
 * Heartbeat configuration.
 */
export interface HeartbeatConfig {
  /** Enable heartbeat feature (default: true) */
  enabled: boolean
  /** Check interval in milliseconds (default: 30 minutes) */
  intervalMs: number
  /** Default chat ID to send heartbeat to (optional) */
  defaultChatId?: string | undefined
  /** Default channel to send heartbeat to ('telegram' | 'discord' | 'cli') */
  defaultChannel?: 'telegram' | 'discord' | 'cli' | undefined
}

/**
 * Tracks activity and sends periodic heartbeat messages.
 *
 * The heartbeat checks at the configured interval and sends a message
 * only if useful output has been produced since the last heartbeat.
 */
export class Heartbeat {
  private running = false
  private timer: NodeJS.Timeout | null = null
  private lastHeartbeatTime = Date.now()
  private activitySinceLastHeartbeat = false
  private outboundMessagesCount = 0
  private lastActivityTimestamp: string | null = null

  constructor(
    private readonly config: HeartbeatConfig,
    private readonly bus: MessageBus,
    private readonly logger: Logger
  ) {}

  /** Starts the heartbeat loop. */
  start(): void {
    if (!this.config.enabled) {
      this.logger.info('heartbeat.disabled')
      return
    }

    this.running = true
    this.lastHeartbeatTime = Date.now()
    this.logger.info('heartbeat.started', { intervalMs: this.config.intervalMs })

    // Subscribe to outbound messages to track activity
    this.subscribeToActivity()

    // Start the periodic check
    this.timer = setInterval(() => {
      void this.check()
    }, this.config.intervalMs)
  }

  /** Stops the heartbeat loop. */
  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.logger.info('heartbeat.stopped')
  }

  /** Records that useful activity has occurred. */
  private recordActivity(): void {
    this.activitySinceLastHeartbeat = true
    this.outboundMessagesCount++
    this.lastActivityTimestamp = new Date().toISOString()
  }

  /** Subscribes to the message bus to track outbound messages. */
  private subscribeToActivity(): void {
    // We need to intercept publishOutbound calls to track activity
    // This is done by wrapping the original method
    const originalPublishOutbound = this.bus.publishOutbound.bind(this.bus)
    this.bus.publishOutbound = async (msg) => {
      // Only count non-empty, non-progress messages as useful output
      if (msg.content && msg.content.length > 0 && !msg.metadata?.kind) {
        this.recordActivity()
      }
      return originalPublishOutbound(msg)
    }
  }

  /** Performs the heartbeat check. */
  private async check(): Promise<void> {
    if (!this.running) return

    const now = Date.now()
    const timeSinceLastHeartbeat = now - this.lastHeartbeatTime

    if (timeSinceLastHeartbeat < this.config.intervalMs) {
      return
    }

    if (!this.activitySinceLastHeartbeat) {
      this.logger.info('heartbeat.no_activity')
      this.lastHeartbeatTime = now
      return
    }

    // Send heartbeat message
    const message = this.formatHeartbeatMessage()
    this.logger.info('heartbeat.sending', {
      messagesCount: this.outboundMessagesCount,
      lastActivity: this.lastActivityTimestamp
    })

    // Send to the configured default channel/chat if specified
    if (this.config.defaultChannel && this.config.defaultChatId) {
      await this.bus.publishOutbound({
        channel: this.config.defaultChannel,
        chatId: this.config.defaultChatId,
        content: message
      })
    } else {
      // Log the heartbeat if no default destination is configured
      this.logger.info('heartbeat.message', { message })
    }

    // Reset tracking
    this.lastHeartbeatTime = now
    this.activitySinceLastHeartbeat = false
    this.outboundMessagesCount = 0
    this.lastActivityTimestamp = null
  }

  /** Formats the heartbeat message. */
  private formatHeartbeatMessage(): string {
    const parts: string[] = ['💓 Heartbeat']

    if (this.outboundMessagesCount > 0) {
      parts.push(`- ${this.outboundMessagesCount} message${this.outboundMessagesCount > 1 ? 's' : ''} sent`)
    }

    if (this.lastActivityTimestamp) {
      const lastActivity = new Date(this.lastActivityTimestamp)
      const timeAgo = Math.floor((Date.now() - lastActivity.getTime()) / 1000 / 60)
      parts.push(`- last activity ${timeAgo}m ago`)
    }

    return parts.join(' ')
  }
}

/**
 * Creates a heartbeat instance from config.
 */
export function createHeartbeat(
  config: ClaudePipeConfig,
  bus: MessageBus,
  logger: Logger
): Heartbeat {
  const heartbeatConfig: HeartbeatConfig = {
    enabled: config.heartbeat?.enabled ?? true,
    intervalMs: (config.heartbeat?.intervalMinutes ?? 30) * 60 * 1000,
    defaultChatId: config.heartbeat?.defaultChatId,
    defaultChannel: config.heartbeat?.defaultChannel
  }

  return new Heartbeat(heartbeatConfig, bus, logger)
}

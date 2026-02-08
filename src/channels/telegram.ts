import type { MicroclawConfig } from '../config/schema.js'
import { MessageBus } from '../core/bus.js'
import { chunkText } from '../core/text-chunk.js'
import type { InboundMessage, Logger, OutboundMessage } from '../core/types.js'
import { isSenderAllowed, type Channel } from './base.js'

type TelegramUpdate = {
  update_id: number
  message?: {
    message_id: number
    text?: string
    chat: { id: number }
    from?: { id: number }
  }
}

const TELEGRAM_MESSAGE_MAX = 3800

/**
 * Telegram adapter using Bot API long polling.
 */
export class TelegramChannel implements Channel {
  readonly name = 'telegram' as const
  private running = false
  private pollTask: Promise<void> | null = null
  private nextOffset = 0

  constructor(
    private readonly config: MicroclawConfig,
    private readonly bus: MessageBus,
    private readonly logger: Logger
  ) {}

  /** Starts background polling when Telegram is enabled. */
  async start(): Promise<void> {
    if (!this.config.channels.telegram.enabled) return
    if (!this.config.channels.telegram.token) {
      this.logger.warn('channel.telegram.misconfigured', { reason: 'missing token' })
      return
    }

    this.running = true
    this.pollTask = this.pollLoop()
    this.logger.info('channel.telegram.start')
  }

  /** Stops polling and waits for loop completion. */
  async stop(): Promise<void> {
    this.running = false
    await this.pollTask
    this.logger.info('channel.telegram.stop')
  }

  /** Sends a text response to Telegram chat. */
  async send(message: OutboundMessage): Promise<void> {
    if (!this.config.channels.telegram.enabled) return

    const token = this.config.channels.telegram.token
    const url = `https://api.telegram.org/bot${token}/sendMessage`
    const chunks = chunkText(message.content, TELEGRAM_MESSAGE_MAX)

    for (const part of chunks) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: Number(message.chatId),
          text: part
        })
      })

      if (!response.ok) {
        const body = await response.text()
        this.logger.error('channel.telegram.send_failed', {
          chatId: message.chatId,
          status: response.status,
          body
        })
        break
      }
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.getUpdates()
        for (const update of updates) {
          this.nextOffset = Math.max(this.nextOffset, update.update_id + 1)
          if (!update.message) continue
          await this.handleMessage(update)
        }
      } catch (error) {
        this.logger.error('channel.telegram.poll_error', {
          error: error instanceof Error ? error.message : String(error)
        })
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const token = this.config.channels.telegram.token
    const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`)
    url.searchParams.set('timeout', '25')
    url.searchParams.set('offset', String(this.nextOffset))

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Telegram getUpdates failed: ${response.status}`)
    }

    const json = (await response.json()) as { ok: boolean; result: TelegramUpdate[] }
    if (!json.ok) return []
    return json.result ?? []
  }

  private async handleMessage(update: TelegramUpdate): Promise<void> {
    const message = update.message
    if (!message?.from) return

    const senderId = String(message.from.id)
    if (!isSenderAllowed(senderId, this.config.channels.telegram.allowFrom)) {
      this.logger.warn('channel.telegram.denied', { senderId })
      return
    }

    const inbound: InboundMessage = {
      channel: 'telegram',
      senderId,
      chatId: String(message.chat.id),
      content: message.text?.trim() || '[empty message]',
      timestamp: new Date().toISOString(),
      metadata: {
        messageId: message.message_id
      }
    }

    await this.bus.publishInbound(inbound)
  }
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'

import type { CommandMeta } from '../commands/types.js'
import type { ClaudePipeConfig } from '../config/schema.js'
import { MessageBus } from '../core/bus.js'
import { retry } from '../core/retry.js'
import { chunkText } from '../core/text-chunk.js'
import type { InboundMessage, Logger, OutboundMessage } from '../core/types.js'
import { isSenderAllowed, type Channel } from './base.js'

export type TelegramUpdate = {
  update_id: number
  message?: {
    message_id: number
    text?: string
    chat: { id: number }
    from?: { id: number }
  }
}

const TELEGRAM_MESSAGE_MAX = 3800
const SEND_RETRY_ATTEMPTS = 2
const SEND_RETRY_BACKOFF_MS = 50
const DEFAULT_WEBHOOK_PORT = 8443

/** Telegram Bot API chat actions for typing indicators. */
type ChatAction = 'typing' | 'upload_photo' | 'upload_video' | 'upload_audio' | 'upload_document' | 'find_location' | 'record_video' | 'record_voice'

/**
 * Telegram adapter using WebSocket server for receiving updates.
 *
 * Starts an HTTP server that accepts Telegram webhook POST requests and a
 * WebSocket server for real-time bidirectional communication. Both paths
 * converge into the same update handler. Outbound messages are sent via
 * the standard Telegram Bot HTTP API.
 */
export class TelegramChannel implements Channel {
  readonly name = 'telegram' as const
  private running = false
  private httpServer: Server | null = null
  private wss: WebSocketServer | null = null
  /** Tracks chat IDs pending responses for typing indicator cleanup. */
  private pendingTyping = new Set<string>()

  constructor(
    private readonly config: ClaudePipeConfig,
    private readonly bus: MessageBus,
    private readonly logger: Logger
  ) {}

  /** Starts the HTTP + WebSocket server when Telegram is enabled. */
  async start(): Promise<void> {
    if (!this.config.channels.telegram.enabled) return
    if (!this.config.channels.telegram.token) {
      this.logger.warn('channel.telegram.misconfigured', { reason: 'missing token' })
      return
    }

    this.running = true

    const port = this.config.channels.telegram.webhookPort ?? DEFAULT_WEBHOOK_PORT

    this.httpServer = createServer((req, res) => {
      void this.handleHttpRequest(req, res)
    })

    this.wss = new WebSocketServer({ server: this.httpServer })
    this.wss.on('connection', (ws) => {
      this.logger.info('channel.telegram.ws_client_connected')
      ws.on('message', (data) => {
        try {
          const update = JSON.parse(String(data)) as TelegramUpdate
          void this.handleUpdate(update)
        } catch (error) {
          this.logger.error('channel.telegram.ws_parse_error', {
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })
      ws.on('close', () => {
        this.logger.info('channel.telegram.ws_client_disconnected')
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject)
      this.httpServer!.listen(port, () => {
        this.httpServer!.removeListener('error', reject)
        resolve()
      })
    })

    this.logger.info('channel.telegram.start', { port })

    // Register webhook URL with Telegram if configured
    const webhookUrl = this.config.channels.telegram.webhookUrl
    if (webhookUrl) {
      await this.setWebhook(webhookUrl)
    }
  }

  /** Stops the HTTP + WebSocket server. */
  async stop(): Promise<void> {
    this.running = false

    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close()
      }
      this.wss.close()
      this.wss = null
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve())
      })
      this.httpServer = null
    }

    this.logger.info('channel.telegram.stop')
  }

  /** Returns the address the HTTP server is listening on (useful for tests). */
  get address(): { port: number; host: string } | null {
    const addr = this.httpServer?.address()
    if (!addr || typeof addr === 'string') return null
    return { port: addr.port, host: addr.address }
  }

  /** Sends a text response to Telegram chat. */
  async send(message: OutboundMessage): Promise<void> {
    if (!this.config.channels.telegram.enabled) return
    if (message.metadata?.kind === 'progress') {
      await this.sendChatAction(message.chatId, 'typing')
      return
    }

    const token = this.config.channels.telegram.token
    const url = `https://api.telegram.org/bot${token}/sendMessage`
    const chunks = chunkText(message.content, TELEGRAM_MESSAGE_MAX)

    for (const part of chunks) {
      try {
        await retry(
          async () => {
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                chat_id: Number(message.chatId),
                text: part,
                parse_mode: 'Markdown'
              })
            })

            if (!response.ok) {
              const body = await response.text()
              throw new Error(`telegram send failed (${response.status}): ${body}`)
            }
          },
          {
            attempts: SEND_RETRY_ATTEMPTS,
            backoffMs: SEND_RETRY_BACKOFF_MS
          }
        )
      } catch (error) {
        this.logger.error('channel.telegram.send_failed', {
          chatId: message.chatId,
          error: error instanceof Error ? error.message : String(error)
        })
        break
      }
    }

    // Clear typing indicator after response is sent
    this.pendingTyping.delete(message.chatId)
  }

  /** Broadcasts an event to all connected WebSocket clients. */
  broadcast(data: Record<string, unknown>): void {
    if (!this.wss) return
    const payload = JSON.stringify(data)
    for (const client of this.wss.clients) {
      if (client.readyState === 1 /* WebSocket.OPEN */) {
        client.send(payload)
      }
    }
  }

  /** Sends a chat action (typing, uploading, etc.) to Telegram. */
  private async sendChatAction(chatId: string, action: ChatAction): Promise<void> {
    const token = this.config.channels.telegram.token
    const url = `https://api.telegram.org/bot${token}/sendChatAction`

    try {
      await retry(
        async () => {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chat_id: Number(chatId),
              action
            })
          })

          if (!response.ok) {
            const body = await response.text()
            throw new Error(`telegram sendChatAction failed (${response.status}): ${body}`)
          }
        },
        {
          attempts: 1,
          backoffMs: 0
        }
      )
    } catch {
      // Silently fail - typing indicator is non-critical
    }
  }

  /** Handles incoming HTTP requests (Telegram webhook POST). */
  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }

    const body = await this.readBody(req)

    // Verify webhook secret if configured
    const secret = this.config.channels.telegram.webhookSecret
    if (secret) {
      const header = req.headers['x-telegram-bot-api-secret-token']
      if (header !== secret) {
        this.logger.warn('channel.telegram.webhook_auth_failed')
        res.writeHead(403)
        res.end()
        return
      }
    }

    try {
      const update = JSON.parse(body) as TelegramUpdate
      void this.handleUpdate(update)
      res.writeHead(200)
      res.end('ok')
    } catch {
      res.writeHead(400)
      res.end('invalid json')
    }
  }

  /** Reads the full request body as a string. */
  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk: Buffer) => { data += chunk.toString() })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
  }

  /** Processes a Telegram update from any source (HTTP webhook or WebSocket). */
  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (!update.message) return
    await this.handleMessage(update)
  }

  private async handleMessage(update: TelegramUpdate): Promise<void> {
    const message = update.message
    if (!message?.from) return

    const senderId = String(message.from.id)
    if (!isSenderAllowed(senderId, this.config.channels.telegram.allowFrom)) {
      this.logger.warn('channel.telegram.denied', { senderId })
      return
    }

    const chatId = String(message.chat.id)
    // Show typing indicator while agent processes the message
    this.pendingTyping.add(chatId)
    await this.sendChatAction(chatId, 'typing')

    const inbound: InboundMessage = {
      channel: 'telegram',
      senderId,
      chatId,
      content: message.text?.trim() || '[empty message]',
      timestamp: new Date().toISOString(),
      metadata: {
        messageId: message.message_id
      }
    }

    await this.bus.publishInbound(inbound)
  }

  /** Registers the webhook URL with Telegram's API. */
  private async setWebhook(url: string): Promise<void> {
    const token = this.config.channels.telegram.token
    const secret = this.config.channels.telegram.webhookSecret

    const body: Record<string, unknown> = { url }
    if (secret) {
      body['secret_token'] = secret
    }

    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })

      if (!response.ok) {
        const text = await response.text()
        this.logger.error('channel.telegram.set_webhook_failed', {
          status: response.status,
          body: text
        })
        return
      }

      this.logger.info('channel.telegram.webhook_registered', { url })
    } catch (error) {
      this.logger.error('channel.telegram.set_webhook_failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * Registers bot commands with Telegram's BotFather via the `setMyCommands` API.
   *
   * Should be called once during deployment.
   * Accepts command metadata from {@link CommandRegistry.toMeta()}.
   */
  static async registerBotCommands(
    token: string,
    commands: CommandMeta[],
    logger: Logger
  ): Promise<void> {
    const body = commands.map((cmd) => ({
      command: cmd.telegramName,
      description: cmd.description
    }))

    const url = `https://api.telegram.org/bot${token}/setMyCommands`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commands: body })
    })

    if (!response.ok) {
      const text = await response.text()
      logger.error('channel.telegram.set_commands_failed', { status: response.status, body: text })
      return
    }

    logger.info('channel.telegram.commands_registered', { count: body.length })
  }

  /**
   * Generates a BotFather-compatible command list string.
   *
   * Useful for manual `/setcommands` configuration.
   */
  static formatBotFatherCommands(commands: CommandMeta[]): string {
    return commands.map((cmd) => `${cmd.telegramName} - ${cmd.description}`).join('\n')
  }
}

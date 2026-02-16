import { unlink } from 'node:fs/promises'

import type { CommandMeta } from '../commands/types.js'
import type { ClaudePipeConfig } from '../config/schema.js'
import { MessageBus } from '../core/bus.js'
import { retry } from '../core/retry.js'
import { chunkText } from '../core/text-chunk.js'
import type { Attachment, InboundMessage, Logger, OutboundMessage } from '../core/types.js'
import { isSenderAllowed, type Channel } from './base.js'
import {
  transcribeAudio,
  downloadToTemp,
  WHISPER_INSTALL_INSTRUCTIONS
} from '../audio/whisper.js'

type TelegramVoice = {
  file_id: string
  file_unique_id: string
  duration: number
  mime_type?: string
  file_size?: number
}

type TelegramAudio = {
  file_id: string
  file_unique_id: string
  duration: number
  mime_type?: string
  file_size?: number
  title?: string
  performer?: string
}

type TelegramPhotoSize = {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

type TelegramDocument = {
  file_id: string
  file_unique_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

type TelegramVideo = {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  duration: number
  mime_type?: string
  file_size?: number
}

type TelegramUpdate = {
  update_id: number
  message?: {
    message_id: number
    text?: string
    caption?: string
    voice?: TelegramVoice
    audio?: TelegramAudio
    photo?: TelegramPhotoSize[]
    document?: TelegramDocument
    video?: TelegramVideo
    chat: { id: number }
    from?: { id: number }
  }
}

const TELEGRAM_MESSAGE_MAX = 3800
const SEND_RETRY_ATTEMPTS = 2
const SEND_RETRY_BACKOFF_MS = 50

/** Telegram Bot API chat actions for typing indicators. */
type ChatAction = 'typing' | 'upload_photo' | 'upload_video' | 'upload_audio' | 'upload_document' | 'find_location' | 'record_video' | 'record_voice'

/**
 * Telegram adapter using Bot API long polling.
 */
export class TelegramChannel implements Channel {
  readonly name = 'telegram' as const
  private running = false
  private pollTask: Promise<void> | null = null
  private nextOffset = 0
  /** Tracks chat IDs pending responses for typing indicator cleanup. */
  private pendingTyping = new Set<string>()

  constructor(
    private readonly config: ClaudePipeConfig,
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

  /** Sends a text response (and optional attachments) to Telegram chat. */
  async send(message: OutboundMessage): Promise<void> {
    if (!this.config.channels.telegram.enabled) return
    if (message.metadata?.kind === 'progress') {
      await this.sendChatAction(message.chatId, 'typing')
      return
    }

    const token = this.config.channels.telegram.token

    // Send attachments first if present
    if (message.attachments && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        await this.sendAttachment(message.chatId, attachment, token)
      }
    }

    // Send text content if present
    if (message.content && message.content.trim()) {
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
    }

    // Clear typing indicator after response is sent
    this.pendingTyping.delete(message.chatId)
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

  /**
   * Sends an attachment to a Telegram chat.
   * Supports sending images, videos, documents, and audio files via URL or file path.
   */
  private async sendAttachment(chatId: string, attachment: Attachment, token: string): Promise<void> {
    let endpoint: string
    let fileFieldName: string

    // Determine the appropriate Telegram API endpoint based on attachment type
    switch (attachment.type) {
      case 'image':
        endpoint = 'sendPhoto'
        fileFieldName = 'photo'
        break
      case 'video':
        endpoint = 'sendVideo'
        fileFieldName = 'video'
        break
      case 'audio':
        endpoint = 'sendAudio'
        fileFieldName = 'audio'
        break
      case 'document':
      case 'file':
      default:
        endpoint = 'sendDocument'
        fileFieldName = 'document'
        break
    }

    const url = `https://api.telegram.org/bot${token}/${endpoint}`

    try {
      await retry(
        async () => {
          const payload: Record<string, unknown> = {
            chat_id: Number(chatId)
          }

          // Use URL if available, otherwise skip local paths
          if (attachment.url) {
            payload[fileFieldName] = attachment.url
          } else if (attachment.path) {
            // Local file paths require multipart/form-data upload
            // Telegram doesn't accept file paths in JSON payloads
            // For now, skip local files - only URLs are supported
            this.logger.warn('channel.telegram.attachment_local_path_unsupported', {
              chatId,
              path: attachment.path,
              filename: attachment.filename
            })
            return
          } else {
            throw new Error('Attachment must have either url or path')
          }

          // Add caption if there's a filename
          if (attachment.filename) {
            payload.caption = attachment.filename
          }

          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
          })

          if (!response.ok) {
            const body = await response.text()
            throw new Error(`telegram ${endpoint} failed (${response.status}): ${body}`)
          }
        },
        {
          attempts: SEND_RETRY_ATTEMPTS,
          backoffMs: SEND_RETRY_BACKOFF_MS
        }
      )

      this.logger.info('channel.telegram.attachment_sent', {
        chatId,
        type: attachment.type,
        filename: attachment.filename
      })
    } catch (error) {
      this.logger.error('channel.telegram.attachment_send_failed', {
        chatId,
        type: attachment.type,
        error: error instanceof Error ? error.message : String(error)
      })
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

    const chatId = String(message.chat.id)
    // Show typing indicator while agent processes the message
    this.pendingTyping.add(chatId)
    await this.sendChatAction(chatId, 'typing')

    let content: string
    const attachments: InboundMessage['attachments'] = []

    // Process voice or audio messages
    if (message.voice || message.audio) {
      content = await this.processAudioMessage(message)
    } else {
      content = message.text?.trim() || message.caption?.trim() || '[empty message]'
    }

    // Process photo attachments
    if (message.photo && message.photo.length > 0) {
      // Telegram sends multiple sizes; use the largest one
      const largestPhoto = message.photo.reduce((prev, current) =>
        (current.file_size ?? 0) > (prev.file_size ?? 0) ? current : prev
      )
      const filePath = await this.getFilePath(largestPhoto.file_id)
      if (filePath) {
        const token = this.config.channels.telegram.token
        const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`
        attachments.push({
          type: 'image',
          url: fileUrl,
          filename: filePath.split('/').pop() || 'photo.jpg',
          ...(largestPhoto.file_size !== undefined ? { size: largestPhoto.file_size } : {})
        })
        this.logger.info('channel.telegram.photo_attached', {
          fileId: largestPhoto.file_id,
          size: largestPhoto.file_size
        })
      }
    }

    // Process document attachments
    if (message.document) {
      const filePath = await this.getFilePath(message.document.file_id)
      if (filePath) {
        const token = this.config.channels.telegram.token
        const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`
        attachments.push({
          type: 'document',
          url: fileUrl,
          filename: message.document.file_name || filePath.split('/').pop() || 'document',
          ...(message.document.mime_type !== undefined ? { mimeType: message.document.mime_type } : {}),
          ...(message.document.file_size !== undefined ? { size: message.document.file_size } : {})
        })
        this.logger.info('channel.telegram.document_attached', {
          fileId: message.document.file_id,
          filename: message.document.file_name,
          size: message.document.file_size
        })
      }
    }

    // Process video attachments
    if (message.video) {
      const filePath = await this.getFilePath(message.video.file_id)
      if (filePath) {
        const token = this.config.channels.telegram.token
        const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`
        attachments.push({
          type: 'video',
          url: fileUrl,
          filename: filePath.split('/').pop() || 'video.mp4',
          ...(message.video.mime_type !== undefined ? { mimeType: message.video.mime_type } : {}),
          ...(message.video.file_size !== undefined ? { size: message.video.file_size } : {})
        })
        this.logger.info('channel.telegram.video_attached', {
          fileId: message.video.file_id,
          size: message.video.file_size
        })
      }
    }

    const inbound: InboundMessage = {
      channel: 'telegram',
      senderId,
      chatId,
      content,
      timestamp: new Date().toISOString(),
      ...(attachments.length > 0 ? { attachments } : {}),
      metadata: {
        messageId: message.message_id
      }
    }

    await this.bus.publishInbound(inbound)
  }

  /**
   * Processes a voice or audio message: downloads the file from Telegram,
   * transcribes it with whisper-cpp, and returns the content string.
   *
   * Falls back to a contextual message with install instructions when
   * whisper-cpp is unavailable.
   */
  private async processAudioMessage(
    message: NonNullable<TelegramUpdate['message']>
  ): Promise<string> {
    const voiceOrAudio = message.voice ?? message.audio
    if (!voiceOrAudio) return '[empty audio message]'

    const fileId = voiceOrAudio.file_id
    const duration = voiceOrAudio.duration

    let audioPath: string | null = null
    try {
      // Get file path from Telegram
      const filePath = await this.getFilePath(fileId)
      if (!filePath) {
        this.logger.error('channel.telegram.audio_file_not_found', { fileId })
        return '[audio message — could not retrieve file from Telegram]'
      }

      // Download the audio file
      const token = this.config.channels.telegram.token
      const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`
      const ext = filePath.includes('.') ? `.${filePath.split('.').pop()}` : '.ogg'
      audioPath = await downloadToTemp(fileUrl, ext)

      this.logger.info('channel.telegram.audio_downloaded', {
        fileId,
        duration,
        path: audioPath
      })

      // Transcribe using whisper-cpp
      const result = await transcribeAudio(audioPath)

      if (result.success) {
        this.logger.info('channel.telegram.audio_transcribed', {
          fileId,
          textLength: result.text.length
        })
        return `[Voice message transcription]: ${result.text}`
      }

      // whisper-cpp not available — provide context to Claude
      this.logger.warn('channel.telegram.whisper_unavailable', {
        reason: result.reason
      })
      return (
        `[The user sent a voice message (${duration}s) but it could not be transcribed. ` +
        `Reason: ${result.reason}]\n\n${WHISPER_INSTALL_INSTRUCTIONS}`
      )
    } catch (error) {
      this.logger.error('channel.telegram.audio_error', {
        error: error instanceof Error ? error.message : String(error)
      })
      return '[audio message — transcription failed due to an unexpected error]'
    } finally {
      // Clean up downloaded audio file
      if (audioPath) {
        try { await unlink(audioPath) } catch { /* ignore cleanup errors */ }
      }
    }
  }

  /**
   * Resolves a Telegram file_id to a downloadable file_path via the Bot API.
   */
  private async getFilePath(fileId: string): Promise<string | null> {
    const token = this.config.channels.telegram.token
    const url = `https://api.telegram.org/bot${token}/getFile`

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: fileId })
    })

    if (!response.ok) return null

    const json = (await response.json()) as {
      ok: boolean
      result?: { file_path?: string }
    }

    return json.ok ? (json.result?.file_path ?? null) : null
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

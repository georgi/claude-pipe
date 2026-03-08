import { createReadStream, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

import type { CommandMeta } from '../commands/types.js'
import type { ClaudePipeConfig } from '../config/schema.js'
import { MessageBus } from '../core/bus.js'
import { retry } from '../core/retry.js'
import { chunkText } from '../core/text-chunk.js'
import type { FileAttachment, InboundMessage, Logger, OutboundMessage, SentMessage } from '../core/types.js'
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

type TelegramUpdate = {
  update_id: number
  message?: {
    message_id: number
    text?: string
    voice?: TelegramVoice
    audio?: TelegramAudio
    chat: { id: number }
    from?: { id: number }
  }
}

const TELEGRAM_MESSAGE_MAX = 3800
const SEND_RETRY_ATTEMPTS = 2
const SEND_RETRY_BACKOFF_MS = 50
const PID_FILE = join(tmpdir(), 'claude-pipe-telegram.pid')

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

  /** Kills any previously running instance using the PID file. */
  private killExistingInstance(): void {
    if (!existsSync(PID_FILE)) return
    try {
      const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
      if (!pid || pid === process.pid) return
      process.kill(pid, 'SIGTERM')
      this.logger.info('channel.telegram.killed_existing', { pid })
      // Give the old process a moment to release its poll connection
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    } catch {
      // Process already dead or no permission — ignore
    } finally {
      try { unlinkSync(PID_FILE) } catch { /* ignore */ }
    }
  }

  /** Starts background polling when Telegram is enabled. */
  async start(): Promise<void> {
    if (!this.config.channels.telegram.enabled) return
    if (!this.config.channels.telegram.token) {
      this.logger.warn('channel.telegram.misconfigured', { reason: 'missing token' })
      return
    }

    this.killExistingInstance()
    writeFileSync(PID_FILE, String(process.pid), 'utf8')

    this.running = true
    this.pollTask = this.pollLoop()
    this.logger.info('channel.telegram.start')
  }

  /** Stops polling and waits for loop completion. */
  async stop(): Promise<void> {
    this.running = false
    await this.pollTask
    try { unlinkSync(PID_FILE) } catch { /* ignore */ }
    this.logger.info('channel.telegram.stop')
  }

  /** Sends a text response to Telegram chat. Returns a SentMessage for the last chunk. */
  async send(message: OutboundMessage): Promise<SentMessage | void> {
    if (!this.config.channels.telegram.enabled) return
    if (message.metadata?.kind === 'progress') {
      await this.sendChatAction(message.chatId, 'typing')
      return
    }

    const token = this.config.channels.telegram.token
    const url = `https://api.telegram.org/bot${token}/sendMessage`
    const chunks = chunkText(message.content, TELEGRAM_MESSAGE_MAX)

    let lastMessageId: string | undefined
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

            try {
              const json = (await response.json()) as {
                ok: boolean
                result?: { message_id?: number }
              }
              if (json.ok && json.result?.message_id != null) {
                lastMessageId = String(json.result.message_id)
              }
            } catch {
              // Message sent successfully but couldn't parse response for message ID
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

    // Send any file attachments
    if (message.attachments?.length) {
      for (const attachment of message.attachments) {
        const sent = await this.sendFile(message.chatId, attachment)
        if (sent) lastMessageId = sent.messageId
      }
    }

    // Clear typing indicator after response is sent
    this.pendingTyping.delete(message.chatId)

    if (lastMessageId) {
      return { channel: 'telegram', chatId: message.chatId, messageId: lastMessageId }
    }
  }

  /** Sends a file to a Telegram chat using the appropriate API method based on file type. */
  async sendFile(chatId: string, attachment: FileAttachment): Promise<SentMessage | void> {
    if (!this.config.channels.telegram.enabled) return

    const token = this.config.channels.telegram.token
    const ext = extname(attachment.filePath).toLowerCase()
    const isAudio = ['.mp3', '.m4a', '.ogg', '.wav', '.flac', '.aac'].includes(ext)
    const isVoice = ext === '.ogg'
    const isPhoto = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)
    const isVideo = ['.mp4', '.avi', '.mkv', '.mov', '.webm'].includes(ext)

    let method: string
    let fileField: string
    if (isVoice) {
      method = 'sendVoice'
      fileField = 'voice'
    } else if (isAudio) {
      method = 'sendAudio'
      fileField = 'audio'
    } else if (isPhoto) {
      method = 'sendPhoto'
      fileField = 'photo'
    } else if (isVideo) {
      method = 'sendVideo'
      fileField = 'video'
    } else {
      method = 'sendDocument'
      fileField = 'document'
    }

    const url = `https://api.telegram.org/bot${token}/${method}`

    try {
      const { FormData, File } = await import('node:buffer')
        .then(() => globalThis)
        .catch(() => globalThis)

      const fileStream = createReadStream(attachment.filePath)
      const chunks: Buffer[] = []
      for await (const chunk of fileStream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const fileBuffer = Buffer.concat(chunks)
      const fileName = basename(attachment.filePath)

      const form = new FormData()
      form.append('chat_id', String(Number(chatId)))
      form.append(fileField, new File([fileBuffer], fileName))
      if (attachment.caption) {
        form.append('caption', attachment.caption)
      }

      const response = await fetch(url, { method: 'POST', body: form })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`telegram ${method} failed (${response.status}): ${body}`)
      }

      const json = (await response.json()) as {
        ok: boolean
        result?: { message_id?: number }
      }
      if (json.ok && json.result?.message_id != null) {
        return { channel: 'telegram', chatId, messageId: String(json.result.message_id) }
      }
    } catch (error) {
      this.logger.error('channel.telegram.send_file_failed', {
        chatId,
        filePath: attachment.filePath,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** Sends or updates a streaming draft message using Telegram's sendMessageDraft API. */
  async sendMessageDraft(chatId: string, text: string): Promise<SentMessage | void> {
    if (!this.config.channels.telegram.enabled) return

    const token = this.config.channels.telegram.token
    const url = `https://api.telegram.org/bot${token}/sendMessageDraft`

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: Number(chatId),
          draft_id: 1,
          text,
          parse_mode: 'Markdown'
        })
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`telegram sendMessageDraft failed (${response.status}): ${body}`)
      }
    } catch (error) {
      this.logger.error('channel.telegram.draft_failed', {
        chatId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** Edits a previously sent Telegram message. */
  async editMessage(sent: SentMessage, newContent: string): Promise<void> {
    if (!this.config.channels.telegram.enabled) return

    const token = this.config.channels.telegram.token
    const url = `https://api.telegram.org/bot${token}/editMessageText`

    try {
      await retry(
        async () => {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chat_id: Number(sent.chatId),
              message_id: Number(sent.messageId),
              text: newContent,
              parse_mode: 'Markdown'
            })
          })

          if (!response.ok) {
            const body = await response.text()
            throw new Error(`telegram editMessageText failed (${response.status}): ${body}`)
          }
        },
        {
          attempts: SEND_RETRY_ATTEMPTS,
          backoffMs: SEND_RETRY_BACKOFF_MS
        }
      )
    } catch (error) {
      this.logger.error('channel.telegram.edit_failed', {
        chatId: sent.chatId,
        messageId: sent.messageId,
        error: error instanceof Error ? error.message : String(error)
      })
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
        const is409 = error instanceof Error && (error as NodeJS.ErrnoException).code === '409'
        if (is409) {
          this.logger.warn('channel.telegram.conflict', {
            error: 'Another instance is polling — killing it and retrying'
          })
          this.killExistingInstance()
          await new Promise((resolve) => setTimeout(resolve, 2000))
        } else {
          this.logger.error('channel.telegram.poll_error', {
            error: error instanceof Error ? error.message : String(error)
          })
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
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
      const err = new Error(`Telegram getUpdates failed: ${response.status}`)
      ;(err as NodeJS.ErrnoException).code = String(response.status)
      throw err
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

    if (message.voice || message.audio) {
      content = await this.processAudioMessage(message)
    } else {
      content = message.text?.trim() || '[empty message]'
    }

    const inbound: InboundMessage = {
      channel: 'telegram',
      senderId,
      chatId,
      content,
      timestamp: new Date().toISOString(),
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

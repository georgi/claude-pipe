import type { CommandHandler } from '../commands/handler.js'
import type { ChannelManager } from '../channels/manager.js'
import type { ClaudePipeConfig } from '../config/schema.js'
import { applySummaryTemplate } from './prompt-template.js'
import { MessageBus } from './bus.js'
import type { ModelClient } from './model-client.js'
import type { AgentTurnUpdate, ChannelName, FileAttachment, InboundMessage, Logger, SentMessage } from './types.js'
import { resolveWorkspace } from './workspace.js'

/** Truncates a tool detail string to fit in a chat status line. */
function truncateDetail(value: string, max: number): string {
  const oneLine = value.split('\n')[0]!.trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max)}…`
}

/** Strips a workspace prefix from a path for shorter display. */
function stripWorkspace(value: string, workspace: string): string {
  if (!value.startsWith(workspace)) return value
  return value.slice(workspace.length).replace(/^\//, '')
}

const MAX_TOOL_LINES = 10

/**
 * Appends a small footer line showing the current time and completion status.
 * Uses Discord subtext (-#) or Telegram italic as appropriate.
 */
function statusFooter(channel: ChannelName, finished: boolean): string {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false })
  const label = finished ? 'Done' : '⏳ Working...'
  if (channel === 'telegram') return `\n\n_${time} · ${label}_`
  if (channel === 'discord') return `\n\n-# ${time} · ${label}`
  return `\n\n${time} · ${label}`
}

/**
 * Central message-processing loop.
 *
 * Consumes inbound chat events, executes one Claude turn, and publishes outbound replies.
 * When a {@link CommandHandler} is provided it intercepts slash commands before they reach the LLM.
 *
 * When a {@link ChannelManager} is attached, tool call updates are sent as editable messages
 * that get replaced with the final assistant response.
 */
export class AgentLoop {
  private running = false
  private readonly lastProgressByConversation = new Map<string, { key: string; at: number }>()
  private commandHandler: CommandHandler | null = null
  private channelManager: ChannelManager | null = null

  constructor(
    private readonly bus: MessageBus,
    private readonly config: ClaudePipeConfig,
    private readonly client: ModelClient,
    private readonly logger: Logger
  ) {}

  /** Attaches a command handler for slash-command interception. */
  setCommandHandler(handler: CommandHandler): void {
    this.commandHandler = handler
  }

  /** Attaches a channel manager for direct message editing during tool calls. */
  setChannelManager(manager: ChannelManager): void {
    this.channelManager = manager
  }

  /** Starts the infinite processing loop. */
  async start(): Promise<void> {
    this.running = true
    this.logger.info('agent.start', { model: this.config.model })

    let activeTurn: Promise<void> | null = null

    while (this.running) {
      const inbound = await this.bus.consumeInbound()

      // Commands are always processed immediately, even during a turn.
      // This is critical for /stop to cancel an in-progress turn.
      const cmdResult = await this.tryCommand(inbound)
      if (cmdResult) continue

      // Wait for any active turn to finish before starting a new one
      if (activeTurn) {
        await activeTurn
      }

      // Start the turn without blocking — allows commands to be consumed during the turn
      activeTurn = this.processMessage(inbound).catch((error: unknown) => {
        this.logger.error('agent.turn_error', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
    }

    if (activeTurn) {
      await activeTurn
    }
  }

  /**
   * Processes exactly one queued inbound message.
   *
   * Useful for deterministic integration/unit testing and acceptance harnesses.
   */
  async processOnce(): Promise<void> {
    const inbound = await this.bus.consumeInbound()
    const handled = await this.tryCommand(inbound)
    if (!handled) {
      await this.processMessage(inbound)
    }
  }

  /** Stops the loop and closes live Claude sessions. */
  stop(): void {
    this.running = false
    this.client.closeAll()
  }

  /** Tries to handle the message as a command. Returns true if handled. */
  private async tryCommand(inbound: InboundMessage): Promise<boolean> {
    if (!this.commandHandler) return false
    const result = await this.commandHandler.execute(
      inbound.content,
      inbound.channel,
      inbound.chatId,
      inbound.senderId
    )
    if (!result) return false
    await this.bus.publishOutbound({
      channel: inbound.channel,
      chatId: inbound.chatId,
      content: result.content
    })
    this.logger.info('agent.command', {
      conversationKey: `${inbound.channel}:${inbound.chatId}`,
      content: inbound.content
    })
    return true
  }

  private async processMessage(inbound: InboundMessage): Promise<void> {
    const conversationKey = `${inbound.channel}:${inbound.chatId}`
    this.logger.info('agent.inbound', {
      conversationKey,
      senderId: inbound.senderId
    })

    const workspace = resolveWorkspace(this.config, conversationKey)

    const modelInput = applySummaryTemplate(
      inbound.content,
      this.config.summaryPrompt,
      workspace
    )

    let statusMessage: SentMessage | null = null
    let streamMessage: SentMessage | null = null
    const toolUpdates: Array<{ id: string; label: string }> = []
    let heartbeatTimer: NodeJS.Timeout | null = null
    let lastBaseContent = ''
    let lastSentContent = ''
    let lastStreamedText = ''

    const heartbeatCallback = (): void => {
      const tracked = streamMessage ?? statusMessage
      if (!tracked || !this.channelManager) return
      const content = lastBaseContent + statusFooter(inbound.channel, false)
      this.channelManager.editMessage(tracked, content).catch(() => {})
    }

    /** Restarts the heartbeat timer (clears + creates). Use when the tracked message changes. */
    const startHeartbeat = (): void => {
      stopHeartbeat()
      heartbeatTimer = setInterval(heartbeatCallback, 20_000)
    }

    /** Ensures the heartbeat is running without resetting the countdown. */
    const ensureHeartbeat = (): void => {
      if (heartbeatTimer) return
      heartbeatTimer = setInterval(heartbeatCallback, 20_000)
    }

    const stopHeartbeat = (): void => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
    }

    const publishProgress = async (update: AgentTurnUpdate): Promise<void> => {
      if (update.kind === 'turn_started') {
        if (!this.channelManager) return
        lastBaseContent = '🤖 Starting Claude...'
        const statusText = lastBaseContent + statusFooter(inbound.channel, false)
        try {
          const sent = await this.channelManager.sendDirect({
            channel: inbound.channel,
            chatId: inbound.chatId,
            content: statusText
          })
          if (sent) {
            statusMessage = sent
            startHeartbeat()
          }
        } catch {
          // Non-critical — initial status failed
        }
        return
      }

      if (update.kind === 'text_streaming') {
        if (!this.channelManager || !update.text) return

        lastStreamedText = update.text
        lastBaseContent = update.text
        const textWithFooter = update.text + statusFooter(inbound.channel, false)
        try {
          if (streamMessage) {
            await this.channelManager.editMessage(streamMessage, textWithFooter)
          } else if (statusMessage) {
            // Replace tool status with streaming text
            await this.channelManager.editMessage(statusMessage, textWithFooter)
            streamMessage = statusMessage
            startHeartbeat()
          } else {
            const sent = await this.channelManager.sendDraftMessage({
              channel: inbound.channel,
              chatId: inbound.chatId,
              content: textWithFooter
            })
            if (sent) {
              streamMessage = sent
              startHeartbeat()
            }
          }
        } catch {
          // Non-critical — streaming draft update failed
        }
        return
      }

      if (
        update.kind !== 'tool_call_started' &&
        update.kind !== 'tool_call_finished' &&
        update.kind !== 'tool_call_failed'
      ) {
        return
      }

      const key = `${update.kind}:${update.toolName ?? ''}:${update.toolUseId ?? ''}`

      const now = Date.now()
      const recent = this.lastProgressByConversation.get(conversationKey)
      const throttled =
        recent != null &&
        recent.key === key &&
        now - recent.at < 1200 &&
        update.kind !== 'tool_call_started'
      if (throttled) return
      this.lastProgressByConversation.set(conversationKey, { key, at: now })

      this.logger.info('ui.channel.update', {
        conversationKey,
        channel: inbound.channel,
        chatId: inbound.chatId,
        kind: update.kind,
        toolName: update.toolName,
        toolUseId: update.toolUseId,
        message: update.message
      })

      if (!this.channelManager) return

      const toolId = update.toolUseId ?? update.toolName ?? 'tool'
      const toolName = update.toolName ?? 'tool'
      const rawDetail = update.toolDetail ? stripWorkspace(update.toolDetail, workspace) : ''
      const detail = rawDetail ? truncateDetail(rawDetail, 60) : ''
      const toolLabel = detail ? `${toolName}: ${detail}` : toolName

      if (update.kind === 'tool_call_started') {
        toolUpdates.push({ id: toolId, label: `🔧 ${toolLabel}` })
        ensureHeartbeat()
      } else if (update.kind === 'tool_call_finished') {
        const entry = toolUpdates.find((t) => t.id === toolId)
        if (entry) {
          // Preserve detail from start event if finish event has none
          const existing = entry.label.replace(/^[^\s]+\s/, '')
          entry.label = `✅ ${detail ? toolLabel : existing}`
        }
      } else if (update.kind === 'tool_call_failed') {
        const entry = toolUpdates.find((t) => t.id === toolId)
        if (entry) {
          const existing = entry.label.replace(/^[^\s]+\s/, '')
          entry.label = `❌ ${detail ? toolLabel : existing}`
        }
      }

      const overflow = toolUpdates.length - MAX_TOOL_LINES
      const visibleTools = overflow > 0 ? toolUpdates.slice(-MAX_TOOL_LINES) : toolUpdates
      const toolPrefix = overflow > 0 ? `… ${overflow} more\n` : ''
      const toolStatus = toolPrefix + visibleTools.map((t) => t.label).join('\n')

      if (streamMessage) {
        // Append tool progress below the streamed text instead of overwriting
        lastBaseContent = lastStreamedText + '\n\n' + toolStatus
        const content = lastBaseContent + statusFooter(inbound.channel, false)
        if (content !== lastSentContent) {
          lastSentContent = content
          try {
            await this.channelManager.editMessage(streamMessage, content)
          } catch {
            // Non-critical
          }
        }
        return
      }

      lastBaseContent = toolStatus
      const statusText = lastBaseContent + statusFooter(inbound.channel, false)
      try {
        if (statusMessage) {
          await this.channelManager.editMessage(statusMessage, statusText)
        } else {
          const sent = await this.channelManager.sendDirect({
            channel: inbound.channel,
            chatId: inbound.chatId,
            content: statusText
          })
          if (sent) statusMessage = sent
        }
      } catch {
        // Non-critical — log already covers the update
      }
    }

    let rawContent: string
    try {
      rawContent = await this.client.runTurn(conversationKey, modelInput, {
        workspace,
        channel: inbound.channel,
        chatId: inbound.chatId,
        onUpdate: publishProgress
      })
    } finally {
      stopHeartbeat()
    }

    // Turn was cancelled or produced no output — skip publishing
    if (!rawContent) {
      this.logger.info('agent.cancelled', { conversationKey })
      return
    }

    // Extract file attachment markers from the response: [[file:/path/to/file.ext]] or [[file:/path|caption]]
    const attachments: FileAttachment[] = []
    const content = rawContent.replace(
      /\[\[file:([^|\]]+?)(?:\|([^\]]*))?\]\]/g,
      (_match, filePath: string, caption?: string) => {
        const trimmedCaption = caption?.trim()
        attachments.push({ filePath: filePath.trim(), ...(trimmedCaption ? { caption: trimmedCaption } : {}) })
        return ''
      }
    ).trim()

    if (attachments.length > 0) {
      this.logger.info('agent.attachments', {
        conversationKey,
        count: attachments.length,
        files: attachments.map((a) => a.filePath)
      })
    }

    const contentWithFooter = content + statusFooter(inbound.channel, true)
    const outbound = {
      channel: inbound.channel,
      chatId: inbound.chatId,
      content: contentWithFooter,
      ...(attachments.length > 0 ? { attachments } : {})
    }

    // Replace the streaming draft or status message with the final response when possible
    const trackedMessage = streamMessage ?? statusMessage
    if (trackedMessage && this.channelManager) {
      try {
        await this.channelManager.editMessage(trackedMessage, contentWithFooter)
        // Send attachments separately after editing the text
        if (attachments.length > 0) {
          for (const attachment of attachments) {
            await this.channelManager.sendFile(inbound.channel, inbound.chatId, attachment)
          }
        }
      } catch {
        // Fall through to normal outbound publish
        await this.bus.publishOutbound(outbound)
      }
    } else {
      await this.bus.publishOutbound(outbound)
    }

    this.logger.info('agent.outbound', { conversationKey })
  }
}

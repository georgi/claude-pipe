import type { CommandHandler } from '../commands/handler.js'
import type { ChannelManager } from '../channels/manager.js'
import type { ClaudePipeConfig } from '../config/schema.js'
import { applySummaryTemplate } from './prompt-template.js'
import { MessageBus } from './bus.js'
import type { ModelClient } from './model-client.js'
import type { AgentTurnUpdate, FileAttachment, InboundMessage, Logger, SentMessage } from './types.js'

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

    while (this.running) {
      const inbound = await this.bus.consumeInbound()
      await this.processMessage(inbound)
    }
  }

  /**
   * Processes exactly one queued inbound message.
   *
   * Useful for deterministic integration/unit testing and acceptance harnesses.
   */
  async processOnce(): Promise<void> {
    const inbound = await this.bus.consumeInbound()
    await this.processMessage(inbound)
  }

  /** Stops the loop and closes live Claude sessions. */
  stop(): void {
    this.running = false
    this.client.closeAll()
  }

  private async processMessage(inbound: InboundMessage): Promise<void> {
    const conversationKey = `${inbound.channel}:${inbound.chatId}`
    this.logger.info('agent.inbound', {
      conversationKey,
      senderId: inbound.senderId
    })

    if (this.commandHandler) {
      const result = await this.commandHandler.execute(
        inbound.content,
        inbound.channel,
        inbound.chatId,
        inbound.senderId
      )
      if (result) {
        await this.bus.publishOutbound({
          channel: inbound.channel,
          chatId: inbound.chatId,
          content: result.content
        })
        this.logger.info('agent.command', { conversationKey, content: inbound.content })
        return
      }
    }

    const modelInput = applySummaryTemplate(
      inbound.content,
      this.config.summaryPrompt,
      this.config.workspace
    )

    let statusMessage: SentMessage | null = null
    let streamMessage: SentMessage | null = null
    const toolUpdates: Array<{ id: string; label: string }> = []

    const publishProgress = async (update: AgentTurnUpdate): Promise<void> => {
      if (update.kind === 'text_streaming') {
        if (!this.channelManager || !update.text) return

        try {
          if (streamMessage) {
            await this.channelManager.editMessage(streamMessage, update.text)
          } else if (statusMessage) {
            // Replace tool status with streaming text
            await this.channelManager.editMessage(statusMessage, update.text)
            streamMessage = statusMessage
          } else {
            const sent = await this.channelManager.sendDraftMessage({
              channel: inbound.channel,
              chatId: inbound.chatId,
              content: update.text
            })
            if (sent) streamMessage = sent
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
      const toolLabel = update.toolName ?? 'tool'

      if (update.kind === 'tool_call_started') {
        toolUpdates.push({ id: toolId, label: `🔧 ${toolLabel}` })
      } else if (update.kind === 'tool_call_finished') {
        const entry = toolUpdates.find((t) => t.id === toolId)
        if (entry) entry.label = `✅ ${toolLabel}`
      } else if (update.kind === 'tool_call_failed') {
        const entry = toolUpdates.find((t) => t.id === toolId)
        if (entry) entry.label = `❌ ${toolLabel}`
      }

      // Don't overwrite a streaming text draft with tool status
      if (streamMessage) return

      const statusText = toolUpdates.map((t) => t.label).join('\n')
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

    const rawContent = await this.client.runTurn(conversationKey, modelInput, {
      workspace: this.config.workspace,
      channel: inbound.channel,
      chatId: inbound.chatId,
      onUpdate: publishProgress
    })

    // Extract file attachment markers from the response: [[file:/path/to/file.ext]] or [[file:/path|caption]]
    const attachments: FileAttachment[] = []
    const content = rawContent.replace(
      /\[\[file:(.*?)(?:\|(.*?))?\]\]/g,
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

    const outbound = {
      channel: inbound.channel,
      chatId: inbound.chatId,
      content,
      ...(attachments.length > 0 ? { attachments } : {})
    }

    // Replace the streaming draft or status message with the final response when possible
    const trackedMessage = streamMessage ?? statusMessage
    if (trackedMessage && this.channelManager) {
      try {
        await this.channelManager.editMessage(trackedMessage, content)
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

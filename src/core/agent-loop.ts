import type { CommandHandler } from '../commands/handler.js'
import type { ChannelManager } from '../channels/manager.js'
import type { ClaudePipeConfig } from '../config/schema.js'
import type { DailyLog } from '../memory/daily-log.js'
import type { MemoryStore } from '../memory/store.js'
import { applySummaryTemplate } from './prompt-template.js'
import { MessageBus } from './bus.js'
import type { ModelClient } from './model-client.js'
import type {
  AgentTurnUpdate,
  FileAttachment,
  InlineKeyboard,
  InboundMessage,
  Logger,
  SentMessage
} from './types.js'

/**
 * Converts a raw tool name into a human-readable label safe for Telegram Markdown.
 * MCP tools arrive as mcp__ServerName__tool_name — strip the prefix and
 * replace underscores so Telegram does not interpret __x__ as bold formatting.
 */
function formatToolName(name: string): string {
  const mcpMatch = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name)
  const bare = mcpMatch?.[1] ?? name
  return bare.replace(/_/g, ' ')
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
  private memoryStore: MemoryStore | null = null
  private dailyLog: DailyLog | null = null

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

  /** Attaches the persistent memory system. */
  setMemory(store: MemoryStore, dailyLog: DailyLog): void {
    this.memoryStore = store
    this.dailyLog = dailyLog
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

    const modelInput = await this.buildModelInput(inbound)

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
        } catch (err: unknown) {
          this.logger.warn('agent.draft_update_failed', {
            conversationKey,
            error: err instanceof Error ? err.message : String(err)
          })
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
      const toolLabel = formatToolName(update.toolName ?? 'tool')

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
      } catch (err: unknown) {
        this.logger.warn('agent.progress_update_failed', {
          conversationKey,
          error: err instanceof Error ? err.message : String(err)
        })
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
    let processed = rawContent.replace(
      /\[\[file:([^|\]]+?)(?:\|([^\]]*))?\]\]/g,
      (_match, filePath: string, caption?: string) => {
        const trimmedCaption = caption?.trim()
        attachments.push({
          filePath: filePath.trim(),
          ...(trimmedCaption ? { caption: trimmedCaption } : {})
        })
        return ''
      }
    )

    // Extract inline keyboard markers: [[keyboard:Label1=data1,Label2=data2|Label3=data3,Label4=data4]]
    // Pipe separates rows, comma separates buttons within a row
    let keyboard: InlineKeyboard | undefined
    processed = processed.replace(/\[\[keyboard:([^\]]+)\]\]/g, (_match, spec: string) => {
      const rows = spec.split('|').map((row: string) =>
        row.split(',').map((btn: string) => {
          const parts = btn.split('=')
          const text = parts[0] ?? ''
          const callbackData = parts.length > 1 ? parts.slice(1).join('=') : text.trim()
          return { text: text.trim(), callbackData: callbackData.trim() }
        })
      )
      keyboard = rows
      return ''
    })

    // Extract memory save markers: [[memory:key_name|content to remember]]
    processed = processed.replace(
      /\[\[memory:([^|]+)\|([^\]]+)\]\]/g,
      (_match, key: string, value: string) => {
        if (this.memoryStore) {
          try {
            this.memoryStore.save(key.trim(), value.trim())
            this.logger.info('memory.saved', { key: key.trim() })
          } catch (err: unknown) {
            this.logger.warn('memory.save_failed', { key: key.trim(), error: String(err) })
          }
        }
        return ''
      }
    )

    const content = processed.trim()

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
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(keyboard ? { keyboard } : {})
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
      } catch (err: unknown) {
        this.logger.warn('agent.edit_fallback', {
          conversationKey,
          error: err instanceof Error ? err.message : String(err)
        })
        // Fall through to normal outbound publish
        await this.bus.publishOutbound(outbound)
      }
    } else {
      await this.bus.publishOutbound(outbound)
    }

    // Log assistant response to daily log
    if (this.dailyLog) {
      void this.dailyLog.append(conversationKey, 'assistant', content).catch(() => {})
    }

    this.logger.info('agent.outbound', { conversationKey })
  }

  /**
   * Builds the model input by combining memory context with the user message.
   *
   * When memory is available, prepends relevant memories and recent conversation
   * log entries before the actual user request.
   */
  private async buildModelInput(inbound: InboundMessage): Promise<string> {
    const conversationKey = `${inbound.channel}:${inbound.chatId}`
    const baseInput = applySummaryTemplate(
      inbound.content,
      this.config.summaryPrompt,
      this.config.workspace
    )

    // Log inbound message to daily log
    if (this.dailyLog) {
      void this.dailyLog.append(conversationKey, 'user', inbound.content).catch(() => {})
    }

    if (!this.memoryStore && !this.dailyLog) return baseInput

    const sections: string[] = []

    // Search memory for relevant context
    if (this.memoryStore) {
      try {
        const memories = this.memoryStore.search(inbound.content, 5)
        if (memories.length > 0) {
          const lines = memories.map(
            (m) => `- [${m.key}]: ${m.content.slice(0, 200)}`
          )
          sections.push(`# Relevant memories\n${lines.join('\n')}`)
        }
      } catch (err: unknown) {
        this.logger.warn('agent.memory_search_failed', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    // Include recent conversation log entries
    if (this.dailyLog) {
      try {
        const todayLog = await this.dailyLog.getToday()
        if (todayLog) {
          sections.push(`# Today's conversation log\n${todayLog.slice(-2000)}`)
        }
      } catch (err: unknown) {
        this.logger.warn('agent.daily_log_read_failed', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    if (sections.length === 0) return baseInput

    sections.push(`# Current request\n${baseInput}`)
    return sections.join('\n\n')
  }
}

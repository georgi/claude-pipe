import type { CommandHandler } from '../commands/handler.js'
import type { ClaudePipeConfig } from '../config/schema.js'
import { applySummaryTemplate } from './prompt-template.js'
import { MessageBus } from './bus.js'
import type { ModelClient } from './model-client.js'
import type { AgentTurnUpdate, InboundMessage, Logger } from './types.js'

/**
 * Central message-processing loop.
 *
 * Consumes inbound chat events, executes one Claude turn, and publishes outbound replies.
 * When a {@link CommandHandler} is provided it intercepts slash commands before they reach the LLM.
 */
export class AgentLoop {
  private running = false
  private readonly lastProgressByConversation = new Map<string, { key: string; at: number }>()
  private commandHandler: CommandHandler | null = null

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

    const publishProgress = async (update: AgentTurnUpdate): Promise<void> => {
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

      // Log tool call events for debugging, but do not send them to the channel.
      // The agent will naturally explain its actions in text responses before tool calls.
      if (
        update.kind === 'tool_call_started' ||
        update.kind === 'tool_call_finished' ||
        update.kind === 'tool_call_failed'
      ) {
        this.logger.info('ui.channel.update', {
          conversationKey,
          channel: inbound.channel,
          chatId: inbound.chatId,
          kind: update.kind,
          toolName: update.toolName,
          toolUseId: update.toolUseId,
          message: update.message
        })
      }
    }

    const content = await this.client.runTurn(
      conversationKey,
      modelInput,
      {
        workspace: this.config.workspace,
        channel: inbound.channel,
        chatId: inbound.chatId,
        onUpdate: publishProgress
      },
      inbound.attachments
    )

    await this.bus.publishOutbound({
      channel: inbound.channel,
      chatId: inbound.chatId,
      content
    })

    this.logger.info('agent.outbound', { conversationKey })
  }
}

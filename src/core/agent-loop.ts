import type { MicroclawConfig } from '../config/schema.js'
import { applySummaryTemplate } from './prompt-template.js'
import { MessageBus } from './bus.js'
import { ClaudeClient } from './claude-client.js'
import type { AgentTurnUpdate, InboundMessage, Logger } from './types.js'

/**
 * Central message-processing loop.
 *
 * Consumes inbound chat events, executes one Claude turn, and publishes outbound replies.
 */
export class AgentLoop {
  private running = false
  private readonly lastProgressByConversation = new Map<string, { key: string; at: number }>()

  constructor(
    private readonly bus: MessageBus,
    private readonly config: MicroclawConfig,
    private readonly claude: ClaudeClient,
    private readonly logger: Logger
  ) {}

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
    this.claude.closeAll()
  }

  private isNewSessionCommand(input: string): boolean {
    const value = input.trim().toLowerCase()
    return (
      value === '/new' ||
      value === '/newsession' ||
      value === '/new_session' ||
      value === '/reset' ||
      value === '/reset_session'
    )
  }

  private async processMessage(inbound: InboundMessage): Promise<void> {
    const conversationKey = `${inbound.channel}:${inbound.chatId}`
    this.logger.info('agent.inbound', {
      conversationKey,
      senderId: inbound.senderId
    })

    if (this.isNewSessionCommand(inbound.content)) {
      await this.claude.startNewSession(conversationKey)
      await this.bus.publishOutbound({
        channel: inbound.channel,
        chatId: inbound.chatId,
        content: 'Started a new session for this chat.'
      })
      this.logger.info('agent.new_session', { conversationKey })
      return
    }

    const modelInput = applySummaryTemplate(
      inbound.content,
      this.config.summaryPrompt,
      this.config.workspace
    )

    const publishProgress = async (update: AgentTurnUpdate): Promise<void> => {
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

      await this.bus.publishOutbound({
        channel: inbound.channel,
        chatId: inbound.chatId,
        content: '',
        metadata: {
          kind: 'progress',
          progressKind: update.kind,
          message: update.message,
          ...(update.toolName ? { toolName: update.toolName } : {}),
          ...(update.toolUseId ? { toolUseId: update.toolUseId } : {})
        }
      })
    }

    const content = await this.claude.runTurn(conversationKey, modelInput, {
      workspace: this.config.workspace,
      channel: inbound.channel,
      chatId: inbound.chatId,
      onUpdate: publishProgress
    })

    await this.bus.publishOutbound({
      channel: inbound.channel,
      chatId: inbound.chatId,
      content
    })

    this.logger.info('agent.outbound', { conversationKey })
  }
}

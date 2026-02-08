import type { MicroclawConfig } from '../config/schema.js'
import { applySummaryTemplate } from './prompt-template.js'
import { MessageBus } from './bus.js'
import { ClaudeClient } from './claude-client.js'
import type { InboundMessage, Logger } from './types.js'

/**
 * Central message-processing loop.
 *
 * Consumes inbound chat events, executes one Claude turn, and publishes outbound replies.
 */
export class AgentLoop {
  private running = false

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

  private async processMessage(inbound: InboundMessage): Promise<void> {
    const conversationKey = `${inbound.channel}:${inbound.chatId}`
    this.logger.info('agent.inbound', {
      conversationKey,
      senderId: inbound.senderId
    })

    const modelInput = applySummaryTemplate(
      inbound.content,
      this.config.summaryPrompt,
      this.config.workspace
    )

    const content = await this.claude.runTurn(conversationKey, modelInput, {
      workspace: this.config.workspace,
      channel: inbound.channel,
      chatId: inbound.chatId
    })

    await this.bus.publishOutbound({
      channel: inbound.channel,
      chatId: inbound.chatId,
      content
    })

    this.logger.info('agent.outbound', { conversationKey })
  }
}

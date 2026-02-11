import readline from 'node:readline'
import type { Readable, Writable } from 'node:stream'

import type { ClaudePipeConfig } from '../config/schema.js'
import { MessageBus } from '../core/bus.js'
import type { InboundMessage, Logger, OutboundMessage } from '../core/types.js'
import { isSenderAllowed, type Channel } from './base.js'

interface CliChannelIo {
  input: Readable
  output: Writable
}

/**
 * Local terminal channel for testing the bot without Telegram/Discord.
 */
export class CliChannel implements Channel {
  readonly name = 'cli' as const
  private rl: readline.Interface | null = null
  private readonly senderId: string
  private readonly chatId: string
  private readonly io: CliChannelIo

  constructor(
    private readonly config: ClaudePipeConfig,
    private readonly bus: MessageBus,
    private readonly logger: Logger,
    io?: Partial<CliChannelIo>
  ) {
    this.senderId = process.env.CLAUDEPIPE_CLI_SENDER_ID || 'local-user'
    this.chatId = process.env.CLAUDEPIPE_CLI_CHAT_ID || 'local-chat'
    this.io = {
      input: io?.input ?? process.stdin,
      output: io?.output ?? process.stdout
    }
  }

  async start(): Promise<void> {
    if (!this.config.channels.cli?.enabled) return

    this.rl = readline.createInterface({
      input: this.io.input,
      output: this.io.output,
      prompt: 'you> '
    })

    this.rl.on('line', (line) => {
      void this.handleLine(line)
    })
    this.rl.on('close', () => {
      this.logger.info('channel.cli.closed')
    })

    this.io.output.write('CLI channel enabled. Type messages and press Enter.\n')
    this.rl.prompt()
    this.logger.info('channel.cli.start')
  }

  async stop(): Promise<void> {
    if (!this.rl) return
    this.rl.close()
    this.rl = null
    this.logger.info('channel.cli.stop')
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.config.channels.cli?.enabled) return
    if (message.channel !== 'cli') return

    if (message.metadata?.kind === 'progress') {
      const text = typeof message.metadata.message === 'string' ? message.metadata.message : 'working...'
      this.io.output.write(`progress> ${text}\n`)
      return
    }

    if (!message.content.trim()) return
    this.io.output.write(`bot> ${message.content}\n`)
    this.rl?.prompt()
  }

  private async handleLine(raw: string): Promise<void> {
    if (!this.config.channels.cli?.enabled) return

    const content = raw.trim()
    if (!content) {
      this.rl?.prompt()
      return
    }

    const allowFrom = this.config.channels.cli?.allowFrom ?? []
    if (!isSenderAllowed(this.senderId, allowFrom)) {
      this.logger.warn('channel.cli.denied', { senderId: this.senderId })
      this.io.output.write('bot> You are not authorised.\n')
      this.rl?.prompt()
      return
    }

    const inbound: InboundMessage = {
      channel: 'cli',
      senderId: this.senderId,
      chatId: this.chatId,
      content,
      timestamp: new Date().toISOString()
    }
    await this.bus.publishInbound(inbound)
  }
}

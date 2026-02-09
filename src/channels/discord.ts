import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type Message
} from 'discord.js'

import type { CommandMeta } from '../commands/types.js'
import type { ClaudePipeConfig } from '../config/schema.js'
import { MessageBus } from '../core/bus.js'
import { retry } from '../core/retry.js'
import { chunkText } from '../core/text-chunk.js'
import type { InboundMessage, Logger, OutboundMessage } from '../core/types.js'
import { isSenderAllowed, type Channel } from './base.js'

const DISCORD_MESSAGE_MAX = 1800
const SEND_RETRY_ATTEMPTS = 2
const SEND_RETRY_BACKOFF_MS = 50

/**
 * Discord adapter using discord.js gateway client + channel send API.
 */
export class DiscordChannel implements Channel {
  readonly name = 'discord' as const
  private client: Client | null = null

  constructor(
    private readonly config: ClaudePipeConfig,
    private readonly bus: MessageBus,
    private readonly logger: Logger
  ) {}

  /** Initializes and logs in the Discord bot when enabled. */
  async start(): Promise<void> {
    if (!this.config.channels.discord.enabled) return
    if (!this.config.channels.discord.token) {
      this.logger.warn('channel.discord.misconfigured', { reason: 'missing token' })
      return
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Channel]
    })

    this.client.on('ready', () => {
      this.logger.info('channel.discord.ready', {
        user: this.client?.user?.tag ?? 'unknown'
      })
    })

    this.client.on('messageCreate', async (message) => {
      await this.onMessage(message)
    })

    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return
      await this.onInteraction(interaction as ChatInputCommandInteraction)
    })

    this.client.on('error', (error) => {
      this.logger.error('channel.discord.error', { error: error.message })
    })

    await this.client.login(this.config.channels.discord.token)
    this.logger.info('channel.discord.start')
  }

  /** Logs out and destroys the Discord client. */
  async stop(): Promise<void> {
    if (!this.client) return
    await this.client.destroy()
    this.client = null
    this.logger.info('channel.discord.stop')
  }

  /** Sends a text message to a Discord channel by ID. */
  async send(message: OutboundMessage): Promise<void> {
    if (!this.client || !this.config.channels.discord.enabled) return

    const channel = await this.client.channels.fetch(message.chatId)
    if (!channel) {
      this.logger.warn('channel.discord.send_failed', {
        reason: 'channel not found',
        chatId: message.chatId
      })
      return
    }

    if (!channel.isTextBased() || !('send' in channel) || typeof channel.send !== 'function') {
      this.logger.warn('channel.discord.send_failed', {
        reason: 'channel is not send-capable text channel',
        chatId: message.chatId
      })
      return
    }

    if (message.metadata?.kind === 'progress') {
      if ('sendTyping' in channel && typeof channel.sendTyping === 'function') {
        try {
          await retry(
            async () => {
              await channel.sendTyping()
            },
            {
              attempts: SEND_RETRY_ATTEMPTS,
              backoffMs: SEND_RETRY_BACKOFF_MS
            }
          )
        } catch (error) {
          this.logger.error('channel.discord.typing_failed', {
            chatId: message.chatId,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
      return
    }

    for (const part of chunkText(message.content, DISCORD_MESSAGE_MAX)) {
      try {
        await retry(
          async () => {
            await channel.send({ content: part })
          },
          {
            attempts: SEND_RETRY_ATTEMPTS,
            backoffMs: SEND_RETRY_BACKOFF_MS
          }
        )
      } catch (error) {
        this.logger.error('channel.discord.send_failed', {
          chatId: message.chatId,
          error: error instanceof Error ? error.message : String(error)
        })
        break
      }
    }
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return

    const senderId = message.author.id
    if (!isSenderAllowed(senderId, this.config.channels.discord.allowFrom)) {
      this.logger.warn('channel.discord.denied', { senderId })
      return
    }

    if (
      message.channel.type !== ChannelType.GuildText &&
      message.channel.type !== ChannelType.PublicThread &&
      message.channel.type !== ChannelType.PrivateThread &&
      message.channel.type !== ChannelType.DM
    ) {
      return
    }

    const inbound: InboundMessage = {
      channel: 'discord',
      senderId,
      chatId: message.channelId,
      content: message.content?.trim() || '[empty message]',
      timestamp: new Date().toISOString(),
      metadata: {
        messageId: message.id,
        guildId: message.guildId ?? undefined
      }
    }

    await this.bus.publishInbound(inbound)
  }

  /**
   * Handles Discord slash-command interactions.
   *
   * Converts `/command subcommand ...options` into a text-based command string
   * (e.g. `/session_new`) and publishes it as an inbound message so the
   * unified command handler in AgentLoop processes it.
   */
  private async onInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    const senderId = interaction.user.id
    if (!isSenderAllowed(senderId, this.config.channels.discord.allowFrom)) {
      this.logger.warn('channel.discord.denied', { senderId })
      await interaction.reply({ content: 'You are not authorised.', ephemeral: true })
      return
    }

    const subcommand = interaction.options.getSubcommand(false)
    const commandName = subcommand
      ? `/${interaction.commandName}_${subcommand}`
      : `/${interaction.commandName}`

    const promptOption = interaction.options.getString('prompt')
    const content = promptOption ? `${commandName} ${promptOption}` : commandName

    await interaction.deferReply()

    const inbound: InboundMessage = {
      channel: 'discord',
      senderId,
      chatId: interaction.channelId,
      content,
      timestamp: new Date().toISOString(),
      metadata: {
        interactionId: interaction.id,
        guildId: interaction.guildId ?? undefined
      }
    }

    await this.bus.publishInbound(inbound)
  }

  /**
   * Registers Discord application (slash) commands using the REST API.
   *
   * Should be called once during deployment, not on every start.
   * Accepts command metadata from {@link CommandRegistry.toMeta()}.
   */
  static async registerSlashCommands(
    token: string,
    applicationId: string,
    commands: CommandMeta[],
    logger: Logger
  ): Promise<void> {
    const grouped = new Map<string, CommandMeta[]>()
    const standalone: CommandMeta[] = []

    for (const cmd of commands) {
      if (cmd.group) {
        const list = grouped.get(cmd.group) ?? []
        list.push(cmd)
        grouped.set(cmd.group, list)
      } else {
        standalone.push(cmd)
      }
    }

    const body: Array<Record<string, unknown>> = []

    // Standalone commands (e.g. /help, /ping)
    for (const cmd of standalone) {
      body.push({
        name: cmd.name,
        description: cmd.description
      })
    }

    // Grouped commands as subcommands (e.g. /session new, /claude ask)
    for (const [group, cmds] of grouped) {
      body.push({
        name: group,
        description: `${group.charAt(0).toUpperCase() + group.slice(1)} commands`,
        options: cmds.map((cmd) => ({
          type: 1, // SUB_COMMAND
          name: cmd.name,
          description: cmd.description
        }))
      })
    }

    const rest = new REST({ version: '10' }).setToken(token)
    await rest.put(Routes.applicationCommands(applicationId), { body })
    logger.info('channel.discord.slash_commands_registered', { count: body.length })
  }
}

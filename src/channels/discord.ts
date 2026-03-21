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
import type {
  FileAttachment,
  InboundMessage,
  Logger,
  OutboundMessage,
  SentMessage
} from '../core/types.js'
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
  /** Pending deferred interactions keyed by chatId, so send() can resolve them. */
  private pendingInteractions = new Map<string, ChatInputCommandInteraction>()

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

  /** Sends a text message to a Discord channel by ID. Returns a SentMessage for the last chunk. */
  async send(message: OutboundMessage): Promise<SentMessage | void> {
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

    const pendingInteraction = this.pendingInteractions.get(message.chatId)
    if (pendingInteraction) {
      this.pendingInteractions.delete(message.chatId)
    }

    let lastMessageId: string | undefined
    let isFirstChunk = true
    for (const part of chunkText(message.content, DISCORD_MESSAGE_MAX)) {
      try {
        await retry(
          async () => {
            // Resolve the deferred interaction for the first chunk,
            // then fall back to channel.send() for subsequent chunks.
            if (isFirstChunk && pendingInteraction) {
              const sent = await pendingInteraction.editReply({ content: part })
              if (sent && typeof sent === 'object' && 'id' in sent) {
                lastMessageId = String(sent.id)
              }
            } else {
              const sent = await channel.send({ content: part })
              if (sent && typeof sent === 'object' && 'id' in sent) {
                lastMessageId = String(sent.id)
              }
            }
            isFirstChunk = false
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

    if (lastMessageId) {
      return { channel: 'discord', chatId: message.chatId, messageId: lastMessageId }
    }
  }

  /** Edits a previously sent Discord message. */
  async editMessage(sent: SentMessage, newContent: string): Promise<void> {
    if (!this.client || !this.config.channels.discord.enabled) return

    const channel = await this.client.channels.fetch(sent.chatId)
    if (!channel || !channel.isTextBased()) return

    try {
      if ('messages' in channel && channel.messages) {
        const msg = await channel.messages.fetch(sent.messageId)
        await msg.edit({ content: newContent })
      }
    } catch (error) {
      this.logger.error('channel.discord.edit_failed', {
        chatId: sent.chatId,
        messageId: sent.messageId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** Discord does not support message drafts; this is a no-op. */
  async sendMessageDraft(_chatId: string, _text: string): Promise<SentMessage | void> {
    // Discord has no equivalent streaming draft API
  }

  /** Sends a file as a Discord attachment. */
  async sendFile(chatId: string, attachment: FileAttachment): Promise<SentMessage | void> {
    if (!this.client || !this.config.channels.discord.enabled) return

    const channel = await this.client.channels.fetch(chatId)
    if (
      !channel ||
      !channel.isTextBased() ||
      !('send' in channel) ||
      typeof channel.send !== 'function'
    )
      return

    try {
      const sent = await channel.send({
        content: attachment.caption ?? '',
        files: [attachment.filePath]
      })
      if (sent && typeof sent === 'object' && 'id' in sent) {
        return { channel: 'discord', chatId, messageId: String(sent.id) }
      }
    } catch (error) {
      this.logger.error('channel.discord.send_file_failed', {
        chatId,
        filePath: attachment.filePath,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return

    const senderId = message.author.id
    if (!isSenderAllowed(senderId, this.config.channels.discord.allowFrom)) {
      this.logger.warn('channel.discord.denied', { senderId })
      return
    }

    if (!this.isChannelAllowed(message.channelId)) {
      this.logger.warn('channel.discord.denied_channel', {
        senderId,
        chatId: message.channelId
      })
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

    // Process attachments from Discord message
    const attachments: InboundMessage['attachments'] = []
    if (message.attachments && message.attachments.size > 0) {
      for (const [, attachment] of message.attachments) {
        let attachmentType: 'image' | 'video' | 'audio' | 'document' | 'file' = 'file'
        if (attachment.contentType) {
          if (attachment.contentType.startsWith('image/')) {
            attachmentType = 'image'
          } else if (attachment.contentType.startsWith('video/')) {
            attachmentType = 'video'
          } else if (attachment.contentType.startsWith('audio/')) {
            attachmentType = 'audio'
          } else {
            attachmentType = 'document'
          }
        }

        attachments.push({
          type: attachmentType,
          url: attachment.url,
          filename: attachment.name ?? 'attachment',
          ...(attachment.contentType !== null ? { mimeType: attachment.contentType } : {}),
          size: attachment.size
        })

        this.logger.info('channel.discord.attachment', {
          type: attachmentType,
          filename: attachment.name,
          size: attachment.size
        })
      }
    }

    const inbound: InboundMessage = {
      channel: 'discord',
      senderId,
      chatId: message.channelId,
      content: message.content?.trim() || '[empty message]',
      timestamp: new Date().toISOString(),
      ...(attachments.length > 0 ? { attachments } : {}),
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

    if (!this.isChannelAllowed(interaction.channelId)) {
      this.logger.warn('channel.discord.denied_channel', {
        senderId,
        chatId: interaction.channelId
      })
      await interaction.reply({ content: 'This channel is not authorised.', ephemeral: true })
      return
    }

    const subcommand = interaction.options.getSubcommand(false)
    const commandName = subcommand
      ? `/${interaction.commandName}_${subcommand}`
      : `/${interaction.commandName}`

    const promptOption = interaction.options.getString('prompt')
    const content = promptOption ? `${commandName} ${promptOption}` : commandName

    await interaction.deferReply()
    this.pendingInteractions.set(interaction.channelId, interaction)

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

  private isChannelAllowed(chatId: string): boolean {
    const allowChannels = this.config.channels.discord.allowChannels ?? []
    return allowChannels.length === 0 || allowChannels.includes(chatId)
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

import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  ThreadChannel,
  type ChatInputCommandInteraction,
  type Message
} from 'discord.js'

import type { CommandMeta } from '../commands/types.js'
import type { PiPipeConfig } from '../config/schema.js'
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
/** Discord caps thread names at 100 characters. */
const THREAD_NAME_MAX = 90
/** One day — one of Discord's four allowed auto-archive durations. */
const DEFAULT_THREAD_AUTO_ARCHIVE_MINUTES = 1440

/**
 * Discord adapter using discord.js gateway client + channel send API.
 */
export class DiscordChannel implements Channel {
  readonly name = 'discord' as const
  private client: Client | null = null
  /** Pending deferred interactions keyed by chatId, so send() can resolve them. */
  private pendingInteractions = new Map<string, ChatInputCommandInteraction>()
  /**
   * Threads this process opened for a session. Used so the bot keeps replying
   * to every message in them without needing a mention, even when the gateway
   * hands us a partial thread object without a resolvable `ownerId`.
   */
  private readonly ownThreadIds = new Set<string>()
  /**
   * Conversations that already received a channel-history context block.
   * Each thread maps to a persistent agent session, so surrounding history is
   * sent once when the conversation starts — never re-sent on follow-ups.
   */
  private readonly seededChatIds = new Set<string>()

  constructor(
    private readonly config: PiPipeConfig,
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

  /**
   * Edits a previously sent Discord message.
   *
   * Throws if content exceeds {@link DISCORD_MESSAGE_MAX}, since a single
   * Discord message cannot grow past Discord's per-message length limit.
   * Callers handling the final agent response catch this and fall back to
   * chunked sending via the outbound bus; streaming progress callers swallow.
   */
  async editMessage(sent: SentMessage, newContent: string): Promise<void> {
    if (!this.client || !this.config.channels.discord.enabled) return

    if (newContent.length > DISCORD_MESSAGE_MAX) {
      const err = new Error(
        `content length ${newContent.length} exceeds Discord edit limit ${DISCORD_MESSAGE_MAX}`
      )
      this.logger.error('channel.discord.edit_failed', {
        chatId: sent.chatId,
        messageId: sent.messageId,
        error: err.message
      })
      throw err
    }

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

    // Skip channel allowlist for DMs. Thread messages are allowed when either
    // the thread itself or its parent channel is on the allowlist.
    if (
      message.channel.type !== ChannelType.DM &&
      !this.isChannelAllowed(message.channelId, this.parentChannelId(message.channel))
    ) {
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

    // Only respond when mentioned, in a DM, or in a thread the bot started
    const isDM = message.channel.type === ChannelType.DM
    const isThread =
      message.channel.type === ChannelType.PublicThread ||
      message.channel.type === ChannelType.PrivateThread
    const isMentioned = this.client?.user ? message.mentions.has(this.client.user) : false
    const isBotThread =
      isThread &&
      (this.ownThreadIds.has(message.channelId) ||
        (message.channel instanceof ThreadChannel &&
          !!this.client?.user &&
          message.channel.ownerId === this.client.user.id))

    if (!isDM && !isMentioned && !isBotThread) {
      return
    }

    // Strip bot mention from content
    let content = message.content?.trim() || '[empty message]'
    if (this.client?.user) {
      const mentionPattern = new RegExp(`<@!?${this.client.user.id}>\\s*`, 'g')
      content = content.replace(mentionPattern, '').trim() || '[empty message]'
    }

    // Kept before channel context is prepended, so thread names stay readable.
    const userText = content

    // Give every new conversation its own thread, so each thread maps to its
    // own agent session (the conversation key is `discord:<chatId>`).
    let chatId = message.channelId
    let openedNewThread = false
    if (!isDM && !isThread && this.threadsEnabled) {
      const hadThread = message.hasThread && !!message.thread
      const threadId = await this.openThread(message, this.buildThreadName(userText))
      if (threadId) {
        chatId = threadId
        openedNewThread = !hadThread
      }
    }

    // Seed channel history once, only when a thread conversation starts:
    // either a fresh thread opened off a mention (context = the surrounding
    // parent-channel messages) or the first mention in an existing thread the
    // bot does not own (context = the thread so far). Follow-ups in bot
    // threads never re-send history — the agent session already has it.
    const startsForeignThreadConversation =
      isThread && isMentioned && !isBotThread && !this.seededChatIds.has(chatId)
    if ((openedNewThread || startsForeignThreadConversation) && message.channel.isTextBased()) {
      this.seededChatIds.add(chatId)
      const history = await this.fetchHistoryContext(message)
      if (history) {
        content = `[Channel context — recent messages]:\n${history}\n\n[Current message]:\n${content}`
      }
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
      chatId,
      content,
      timestamp: new Date().toISOString(),
      ...(attachments.length > 0 ? { attachments } : {}),
      metadata: {
        messageId: message.id,
        guildId: message.guildId ?? undefined,
        ...(chatId !== message.channelId ? { parentChannelId: message.channelId } : {})
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

    // Skip channel allowlist for DMs
    if (
      interaction.channel?.type !== ChannelType.DM &&
      !this.isChannelAllowed(interaction.channelId, this.parentChannelId(interaction.channel))
    ) {
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

    // Slash commands invoked in a regular text channel also get their own
    // thread; the deferred reply becomes the thread starter message.
    let chatId = interaction.channelId
    if (interaction.channel?.type === ChannelType.GuildText && this.threadsEnabled) {
      const threadId = await this.openInteractionThread(interaction, this.buildThreadName(content))
      if (threadId) chatId = threadId
    }

    // Only resolve the deferred reply in place when the answer stays in this
    // channel — otherwise the response is delivered to the new thread.
    if (chatId === interaction.channelId) {
      this.pendingInteractions.set(interaction.channelId, interaction)
    }

    const inbound: InboundMessage = {
      channel: 'discord',
      senderId,
      chatId,
      content,
      timestamp: new Date().toISOString(),
      metadata: {
        interactionId: interaction.id,
        guildId: interaction.guildId ?? undefined,
        ...(chatId !== interaction.channelId ? { parentChannelId: interaction.channelId } : {})
      }
    }

    await this.bus.publishInbound(inbound)
  }

  /** True unless threads are explicitly disabled in config. */
  private get threadsEnabled(): boolean {
    return this.config.channels.discord.useThreads !== false
  }

  private get threadAutoArchiveMinutes(): number {
    return (
      this.config.channels.discord.threadAutoArchiveMinutes ?? DEFAULT_THREAD_AUTO_ARCHIVE_MINUTES
    )
  }

  /** Reads the parent channel id of a thread, when the channel exposes one. */
  private parentChannelId(channel: unknown): string | undefined {
    if (channel && typeof channel === 'object' && 'parentId' in channel) {
      const parentId = (channel as { parentId?: string | null }).parentId
      return parentId ?? undefined
    }
    return undefined
  }

  /**
   * Fetches the messages preceding the triggering one and formats them as a
   * one-shot context block. The bot's own messages are excluded — they came
   * out of an agent session and would only duplicate what a session already
   * knows. Returns an empty string when there is no usable history.
   */
  private async fetchHistoryContext(message: Message): Promise<string> {
    try {
      const messages = await message.channel.messages.fetch({
        limit: 30,
        before: message.id
      })
      return Array.from(messages.values())
        .reverse()
        .filter((m) => m.author.id !== this.client?.user?.id)
        .map((m) => {
          const text = m.content?.trim() || ''
          return text ? `${m.author.username}: ${text}` : null
        })
        .filter(Boolean)
        .join('\n')
    } catch {
      // Missing history is not fatal — the current message still goes through.
      return ''
    }
  }

  /** Derives a readable thread name from the first line of the user's message. */
  private buildThreadName(content: string): string {
    const cleaned = content
      .replace(/<@!?\d+>/g, '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0)
      ?.replace(/\s+/g, ' ')

    if (!cleaned) return 'New session'
    return cleaned.length > THREAD_NAME_MAX ? `${cleaned.slice(0, THREAD_NAME_MAX - 1)}…` : cleaned
  }

  /**
   * Opens (or reuses) a thread anchored on the triggering message.
   *
   * Returns the thread id, or null when the thread could not be created —
   * e.g. missing "Create Public Threads" permission — so the caller can fall
   * back to replying in the parent channel.
   */
  private async openThread(message: Message, name: string): Promise<string | null> {
    try {
      if (message.hasThread && message.thread) {
        this.ownThreadIds.add(message.thread.id)
        return message.thread.id
      }
      if (typeof message.startThread !== 'function') return null

      const thread = await message.startThread({
        name,
        autoArchiveDuration: this.threadAutoArchiveMinutes
      })
      this.ownThreadIds.add(thread.id)
      this.logger.info('channel.discord.thread_created', {
        threadId: thread.id,
        parentId: message.channelId,
        name
      })
      return thread.id
    } catch (error) {
      this.logger.warn('channel.discord.thread_create_failed', {
        chatId: message.channelId,
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }

  /**
   * Opens a thread anchored on a slash command's deferred reply and points the
   * user at it. Returns null when the thread could not be created.
   */
  private async openInteractionThread(
    interaction: ChatInputCommandInteraction,
    name: string
  ): Promise<string | null> {
    try {
      if (typeof interaction.fetchReply !== 'function') return null
      const reply = await interaction.fetchReply()
      if (!reply || typeof reply.startThread !== 'function') return null

      const thread = await reply.startThread({
        name,
        autoArchiveDuration: this.threadAutoArchiveMinutes
      })
      this.ownThreadIds.add(thread.id)
      await interaction.editReply({ content: `🧵 Continuing in <#${thread.id}>` })
      this.logger.info('channel.discord.thread_created', {
        threadId: thread.id,
        parentId: interaction.channelId,
        name
      })
      return thread.id
    } catch (error) {
      this.logger.warn('channel.discord.thread_create_failed', {
        chatId: interaction.channelId,
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }

  private isChannelAllowed(chatId: string, parentId?: string): boolean {
    const allowChannels = this.config.channels.discord.allowChannels ?? []
    if (allowChannels.length === 0) return true
    return allowChannels.includes(chatId) || (parentId != null && allowChannels.includes(parentId))
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

    // Grouped commands as subcommands (e.g. /session new, /pi ask).
    // The Discord subcommand name must NOT repeat the group prefix, so for a
    // command named `pi_ask` in group `pi` we expose `ask`, not `pi_ask`.
    //
    // Each subcommand exposes a `prompt` string option so users can pass
    // free-form text (`/pi ask prompt: <text>`) — `onInteraction` reads that
    // value via `interaction.options.getString('prompt')`.
    for (const [group, cmds] of grouped) {
      const prefix = `${group}_`
      body.push({
        name: group,
        description: `${group.charAt(0).toUpperCase() + group.slice(1)} commands`,
        options: cmds.map((cmd) => ({
          type: 1, // SUB_COMMAND
          name: cmd.name.startsWith(prefix) ? cmd.name.slice(prefix.length) : cmd.name,
          description: cmd.description,
          options: [
            {
              type: 3, // STRING
              name: 'prompt',
              description: 'Optional prompt or arguments for the command',
              required: false
            }
          ]
        }))
      })
    }

    const rest = new REST({ version: '10' }).setToken(token)
    await rest.put(Routes.applicationCommands(applicationId), { body })
    logger.info('channel.discord.slash_commands_registered', { count: body.length })
  }
}

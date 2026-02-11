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

import { createPublicKey, verify } from 'node:crypto'

import type { CommandMeta } from '../commands/types.js'
import type { ClaudePipeConfig } from '../config/schema.js'
import { MessageBus } from '../core/bus.js'
import { retry } from '../core/retry.js'
import { chunkText } from '../core/text-chunk.js'
import type { InboundMessage, Logger, OutboundMessage } from '../core/types.js'
import { isSenderAllowed, type Channel } from './base.js'
import type { WebhookServer, WebhookResponse } from './webhook-server.js'

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

  /** Initializes and logs in the Discord bot when enabled (gateway mode). */
  async start(): Promise<void> {
    if (!this.config.channels.discord.enabled) return
    if (!this.config.channels.discord.token) {
      this.logger.warn('channel.discord.misconfigured', { reason: 'missing token' })
      return
    }

    // In webhook mode, registration happens via registerWebhook()
    if (this.config.webhook.enabled) return

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

  /**
   * Registers webhook routes for Discord interaction endpoint.
   * Called by ChannelManager when webhook mode is enabled.
   *
   * The interactions endpoint receives slash command payloads via HTTP POST.
   * Requires the application's public key (`webhookSecret`) for Ed25519 signature verification.
   */
  async registerWebhook(server: WebhookServer): Promise<void> {
    if (!this.config.channels.discord.enabled) return

    const publicKeyHex = this.config.channels.discord.webhookSecret
    if (!publicKeyHex) {
      this.logger.warn('channel.discord.webhook_misconfigured', {
        reason: 'missing webhookSecret (Discord application public key)'
      })
      return
    }

    server.addRoute('/webhook/discord', async (body, req) => {
      return this.handleWebhookInteraction(body, req, publicKeyHex)
    })

    this.logger.info('channel.discord.webhook_registered')
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

  /* ------------------------------------------------------------------ */
  /*  Webhook-specific helpers                                           */
  /* ------------------------------------------------------------------ */

  private async handleWebhookInteraction(
    body: string,
    req: import('node:http').IncomingMessage,
    publicKeyHex: string
  ): Promise<WebhookResponse> {
    const signature = req.headers['x-signature-ed25519'] as string | undefined
    const timestamp = req.headers['x-signature-timestamp'] as string | undefined

    if (!signature || !timestamp) {
      return { status: 401, body: JSON.stringify({ error: 'missing signature' }) }
    }

    if (!verifyDiscordSignature(body, signature, timestamp, publicKeyHex)) {
      this.logger.warn('channel.discord.webhook_signature_invalid')
      return { status: 401, body: JSON.stringify({ error: 'invalid signature' }) }
    }

    const payload = JSON.parse(body) as { type: number; [key: string]: unknown }

    // Type 1 = PING (Discord verification handshake)
    if (payload.type === 1) {
      return { status: 200, body: JSON.stringify({ type: 1 }) }
    }

    // Type 2 = APPLICATION_COMMAND
    if (payload.type === 2) {
      const data = payload.data as {
        name: string
        options?: Array<{
          name: string
          type: number
          value?: string
          options?: Array<{ name: string; value: string }>
        }>
      }
      const member = payload.member as { user: { id: string } } | undefined
      const user = payload.user as { id: string } | undefined
      const senderId = member?.user?.id ?? user?.id ?? ''
      const channelId = payload.channel_id as string

      if (!isSenderAllowed(senderId, this.config.channels.discord.allowFrom)) {
        this.logger.warn('channel.discord.denied', { senderId })
        return {
          status: 200,
          body: JSON.stringify({
            type: 4,
            data: { content: 'You are not authorised.', flags: 64 }
          })
        }
      }

      if (!this.isChannelAllowed(channelId)) {
        this.logger.warn('channel.discord.denied_channel', { senderId, chatId: channelId })
        return {
          status: 200,
          body: JSON.stringify({
            type: 4,
            data: { content: 'This channel is not authorised.', flags: 64 }
          })
        }
      }

      // Build command string from interaction data
      const subcommand = data.options?.find((o) => o.type === 1)
      const commandName = subcommand
        ? `/${data.name}_${subcommand.name}`
        : `/${data.name}`

      const promptOpt =
        subcommand?.options?.find((o) => o.name === 'prompt') ??
        data.options?.find((o) => o.name === 'prompt')
      const content = promptOpt?.value
        ? `${commandName} ${promptOpt.value}`
        : commandName

      const inbound: InboundMessage = {
        channel: 'discord',
        senderId,
        chatId: channelId,
        content,
        timestamp: new Date().toISOString(),
        metadata: {
          interactionId: payload.id as string,
          guildId: (payload.guild_id as string) ?? undefined
        }
      }

      await this.bus.publishInbound(inbound)

      // Respond with DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (type 5)
      return { status: 200, body: JSON.stringify({ type: 5 }) }
    }

    return { status: 200, body: JSON.stringify({ type: 1 }) }
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

/* ------------------------------------------------------------------ */
/*  Ed25519 signature verification for Discord interactions             */
/* ------------------------------------------------------------------ */

/** DER/SPKI prefix for Ed25519 public keys. */
const ED25519_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * Verifies a Discord interaction request signature using Ed25519.
 * Exported for testing.
 */
export function verifyDiscordSignature(
  body: string,
  signature: string,
  timestamp: string,
  publicKeyHex: string
): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_DER_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki'
    })

    const message = Buffer.from(timestamp + body)
    const sig = Buffer.from(signature, 'hex')

    return verify(null, message, publicKey, sig)
  } catch {
    return false
  }
}

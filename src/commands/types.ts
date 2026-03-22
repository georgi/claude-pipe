import type { ChannelName } from '../core/types.js'

/** Permission levels for command access control. */
export type PermissionLevel = 'user' | 'admin'

/** Supported command category groupings. */
export type CommandCategory = 'session' | 'claude' | 'config' | 'utility' | 'plugin'

/**
 * Context available to every command handler at execution time.
 */
export interface CommandContext {
  channel: ChannelName
  chatId: string
  senderId: string
  conversationKey: string
  args: string[]
  rawArgs: string
}

/**
 * Result returned by a command handler.
 */
export interface CommandResult {
  content: string
  error?: boolean
}

/**
 * Definition of a single bot command.
 */
export interface CommandDefinition {
  /** Primary command name (e.g. "new", "help"). */
  name: string
  /** Command category for grouping. */
  category: CommandCategory
  /** One-line description shown in help listings. */
  description: string
  /** Longer usage instructions. */
  usage?: string
  /** Alternative names that also trigger this command. */
  aliases?: string[]
  /** Minimum permission level required. */
  permission: PermissionLevel
  /** Execute the command and return a result. */
  execute(ctx: CommandContext): Promise<CommandResult>
}

/**
 * Serializable metadata used for Discord slash command registration
 * and Telegram BotFather `/setcommands`.
 */
export interface CommandMeta {
  name: string
  description: string
  category: CommandCategory
  /** Discord-style subcommand group (e.g. "session" for /session new). */
  group?: string
  /** Telegram-style command name with underscores (e.g. "session_new"). */
  telegramName: string
}

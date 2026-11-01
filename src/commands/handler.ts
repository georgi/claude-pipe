import type { ChannelName } from '../core/types.js'
import type { CommandRegistry } from './registry.js'
import type { CommandResult, PermissionLevel } from './types.js'

/**
 * Parses raw chat messages into command invocations and dispatches them
 * through the {@link CommandRegistry}.
 *
 * Supports both slash-style (`/help`) and platform-prefixed names
 * (`/session_new` on Telegram, `/session new` on Discord).
 */
export class CommandHandler {
  constructor(
    private readonly registry: CommandRegistry,
    private readonly adminIds: string[] | ((channel: ChannelName, senderId: string) => boolean) = []
  ) {}

  /**
   * Returns `true` when the text looks like a command invocation.
   * This allows callers (e.g. AgentLoop) to quickly decide whether to
   * hand the message to the command system or to the LLM.
   */
  isCommand(text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/')) return false
    const name = this.extractCommandName(trimmed)
    return this.registry.has(name)
  }

  /**
   * Attempts to execute a command parsed from the message text.
   *
   * Returns `null` when the text is not a recognised command so callers
   * can fall through to the default message handling path.
   */
  async execute(
    text: string,
    channel: ChannelName,
    chatId: string,
    senderId: string
  ): Promise<CommandResult | null> {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/')) return null

    const name = this.extractCommandName(trimmed)
    const command = this.registry.get(name)
    if (!command) return null

    const isAdmin =
      typeof this.adminIds === 'function'
        ? this.adminIds(channel, senderId)
        : this.adminIds.includes(senderId)
    const senderLevel: PermissionLevel = isAdmin ? 'admin' : 'user'
    if (command.permission === 'admin' && senderLevel !== 'admin') {
      return { content: 'You do not have permission to use this command.', error: true }
    }

    const rawArgs = this.extractRawArgs(trimmed)
    const args = rawArgs ? rawArgs.split(/\s+/) : []

    return command.execute({
      channel,
      chatId,
      senderId,
      conversationKey: `${channel}:${chatId}`,
      args,
      rawArgs
    })
  }

  /**
   * Extracts the canonical command name from a raw message.
   *
   * Handles:
   *  - `/help`                → "help"
   *  - `/session_new`         → "session_new"  (Telegram style)
   *  - `/session new`         → "session_new"  (two-word fallback)
   */
  private extractCommandName(text: string): string {
    // Drop the leading slash
    const withoutSlash = text.slice(1)
    // Handle Telegram @bot suffix (e.g. /help@my_bot)
    const withoutMention = withoutSlash.split('@')[0] ?? withoutSlash
    // Take the first whitespace-separated token as the base name
    const parts = withoutMention.split(/\s+/)
    const first = parts[0]?.toLowerCase() ?? ''

    // If the first token is a registered command, use it directly
    if (this.registry.has(first)) return first

    // Otherwise try collapsing the first two tokens with underscore
    // to support Discord-style `/session new` → "session_new"
    if (parts.length >= 2 && parts[1]) {
      const collapsed = `${first}_${parts[1].toLowerCase()}`
      if (this.registry.has(collapsed)) return collapsed
    }

    return first
  }

  /**
   * Returns everything after the command name portion as a raw string.
   */
  private extractRawArgs(text: string): string {
    const withoutSlash = text.slice(1)
    const parts = withoutSlash.split(/\s+/)
    const first = parts[0]?.toLowerCase() ?? ''

    if (this.registry.has(first)) {
      // Single-token command: args start after first token
      return parts.slice(1).join(' ')
    }

    // Two-token collapsed command: args start after second token
    if (parts.length >= 2 && parts[1]) {
      const collapsed = `${first}_${parts[1].toLowerCase()}`
      if (this.registry.has(collapsed)) {
        return parts.slice(2).join(' ')
      }
    }

    return parts.slice(1).join(' ')
  }
}

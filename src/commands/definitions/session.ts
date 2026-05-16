import type { CommandDefinition, CommandContext, CommandResult } from '../types.js'

/**
 * /new  (aliases: /newsession, /new_session, /reset, /reset_session, /session_new)
 * Starts a fresh Pi session for the current chat.
 */
export function sessionNewCommand(
  startNewSession: (conversationKey: string) => Promise<void>
): CommandDefinition {
  return {
    name: 'session_new',
    category: 'session',
    description: 'Start a new Pi session for this chat',
    usage: '/session_new — clears conversation history and starts fresh',
    aliases: ['new', 'newsession', 'new_session', 'reset', 'reset_session'],
    permission: 'user',
    async execute(ctx: CommandContext): Promise<CommandResult> {
      await startNewSession(ctx.conversationKey)
      return { content: 'Started a new session for this chat.' }
    }
  }
}

/**
 * /session_list
 * Lists active sessions.
 */
export function sessionListCommand(
  listSessions: () => Array<{ key: string; updatedAt: string }>
): CommandDefinition {
  return {
    name: 'session_list',
    category: 'session',
    description: 'List active sessions',
    aliases: [],
    permission: 'admin',
    async execute(): Promise<CommandResult> {
      const sessions = listSessions()
      if (sessions.length === 0) {
        return { content: 'No active sessions.' }
      }
      const lines = sessions.map((s, i) => `${i + 1}. \`${s.key}\` — last active ${s.updatedAt}`)
      return { content: `**Active sessions (${sessions.length}):**\n${lines.join('\n')}` }
    }
  }
}

/**
 * /session_info
 * Shows info about the current chat's session.
 */
export function sessionInfoCommand(
  getSession: (conversationKey: string) => { sessionFile: string; updatedAt: string } | undefined
): CommandDefinition {
  return {
    name: 'session_info',
    category: 'session',
    description: 'Show session info for the current chat',
    aliases: [],
    // Admin-only because session file paths can disclose local filesystem
    // layout (usernames, workspace directories, etc.) to any allowed
    // chat participant.
    permission: 'admin',
    async execute(ctx: CommandContext): Promise<CommandResult> {
      const session = getSession(ctx.conversationKey)
      if (!session) {
        return { content: 'No active session for this chat.' }
      }
      // Show only the basename so the absolute path isn't leaked even to
      // admins via casual screenshot/copy-paste of bot output.
      const basename = session.sessionFile.split(/[/\\]/).pop() ?? session.sessionFile
      return {
        content:
          `**Session info:**\n` +
          `• Session file: \`${basename}\`\n` +
          `• Last active: ${session.updatedAt}`
      }
    }
  }
}

/**
 * /session_delete
 * Deletes the current chat's session.
 */
export function sessionDeleteCommand(
  deleteSession: (conversationKey: string) => Promise<void>
): CommandDefinition {
  return {
    name: 'session_delete',
    category: 'session',
    description: 'Delete the session for the current chat',
    aliases: [],
    permission: 'user',
    async execute(ctx: CommandContext): Promise<CommandResult> {
      await deleteSession(ctx.conversationKey)
      return { content: 'Session deleted for this chat.' }
    }
  }
}

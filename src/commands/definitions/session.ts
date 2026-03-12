import type { ClaudeSessionService, ClaudeSessionSummary } from '../../core/claude-sessions.js'
import type { CommandDefinition, CommandContext, CommandResult } from '../types.js'

function formatSessionInfo(session: ClaudeSessionSummary): string {
  const shortId = session.sessionId.slice(0, 8)
  const lines = [
    `═══════════════════════════════`,
    `✦ Session: ${shortId}`,
    `═══════════════════════════════`,
    `  "${session.firstMessage}"`,
    `  Model: ${session.model || 'unknown'}`,
    `  Messages: ${session.userMessageCount} user / ${session.assistantMessageCount} assistant`,
    `  Last active: ${session.lastActive || 'unknown'}`,
  ]
  if (session.gitBranch) {
    lines.push(`  Branch: ${session.gitBranch}`)
  }
  return lines.join('\n')
}

/**
 * /new  (aliases: /newsession, /new_session, /reset, /reset_session, /session_new)
 * Starts a fresh Claude session for the current chat.
 */
export function sessionNewCommand(
  startNewSession: (conversationKey: string) => Promise<void>
): CommandDefinition {
  return {
    name: 'session_new',
    category: 'session',
    description: 'Start a new Claude session for this chat',
    usage: '/session_new — clears conversation history and starts fresh',
    aliases: ['new', 'newsession', 'new_session', 'reset', 'reset_session'],
    permission: 'user',
    async execute(ctx: CommandContext): Promise<CommandResult> {
      await startNewSession(ctx.conversationKey)
      return { content: '═══════════════════════════════\n✦ New session started\n═══════════════════════════════' }
    }
  }
}

/**
 * /session_list
 * Lists Claude sessions in the current workspace.
 */
export function sessionListCommand(
  getWorkspace: (conversationKey: string) => string,
  sessionService: ClaudeSessionService,
  getSessionId: (conversationKey: string) => string | undefined
): CommandDefinition {
  return {
    name: 'session_list',
    category: 'session',
    description: 'List Claude sessions in the current workspace',
    aliases: [],
    permission: 'user',
    async execute(ctx: CommandContext): Promise<CommandResult> {
      const workspace = getWorkspace(ctx.conversationKey)
      const sessions = await sessionService.list(workspace)
      if (sessions.length === 0) {
        return { content: 'No sessions found for this workspace.' }
      }
      const currentSessionId = getSessionId(ctx.conversationKey)
      const cap = 20
      const shown = sessions.slice(0, cap)
      const lines = shown.map((s, i) => {
        const shortId = s.sessionId.slice(0, 8)
        const msg = s.firstMessage.length > 50 ? s.firstMessage.slice(0, 50) + '…' : s.firstMessage
        const date = s.lastActive ? s.lastActive.slice(0, 10) : 'unknown'
        const active = currentSessionId === s.sessionId ? ' *' : ''
        return `${i + 1}. \`${shortId}\`${active} — "${msg}" (${date})`
      })
      let header = `**Sessions in ${workspace} (${sessions.length}):**`
      if (sessions.length > cap) {
        header += ` (showing ${cap} most recent)`
      }
      return { content: `${header}\n${lines.join('\n')}` }
    }
  }
}

/**
 * /session_select <session_id>
 * Switch to a different Claude session by ID (prefix match supported).
 */
export function sessionSelectCommand(
  getWorkspace: (conversationKey: string) => string,
  sessionService: ClaudeSessionService,
  setSession: (conversationKey: string, sessionId: string) => Promise<void>
): CommandDefinition {
  return {
    name: 'session_select',
    category: 'session',
    description: 'Switch to a session by ID',
    usage: '/session_select <id> — switch to a session (prefix match supported)',
    aliases: ['select', 'switch', 'resume'],
    args: [{ name: 'session_id', description: 'Session ID or prefix', required: true }],
    permission: 'user',
    async execute(ctx: CommandContext): Promise<CommandResult> {
      const prefix = ctx.args[0]
      if (!prefix) {
        return { content: 'Usage: /session select <session_id>', error: true }
      }
      const workspace = getWorkspace(ctx.conversationKey)
      const resolved = await sessionService.resolve(workspace, prefix)
      if ('error' in resolved) {
        return { content: resolved.error, error: true }
      }
      const session = await sessionService.get(workspace, resolved.id)
      if (!session) {
        return { content: 'Failed to read session details.', error: true }
      }
      await setSession(ctx.conversationKey, resolved.id)
      return { content: formatSessionInfo(session) }
    }
  }
}

/**
 * /session_delete [session_id]
 * Deletes a session by ID, or the current chat's session if no ID given.
 */
export function sessionDeleteCommand(
  getWorkspace: (conversationKey: string) => string,
  sessionService: ClaudeSessionService,
  getSessionId: (conversationKey: string) => string | undefined,
  clearSession: (conversationKey: string) => Promise<void>
): CommandDefinition {
  return {
    name: 'session_delete',
    category: 'session',
    description: 'Delete a session by ID or the current session',
    usage: '/session_delete [session_id]',
    aliases: [],
    args: [{ name: 'session_id', description: 'Session ID or prefix (omit to delete current)', required: false }],
    permission: 'user',
    async execute(ctx: CommandContext): Promise<CommandResult> {
      const workspace = getWorkspace(ctx.conversationKey)
      const currentSessionId = getSessionId(ctx.conversationKey)
      const prefix = ctx.args[0]

      if (prefix) {
        // Delete a specific session by ID
        const resolved = await sessionService.resolve(workspace, prefix)
        if ('error' in resolved) {
          return { content: resolved.error, error: true }
        }
        await sessionService.delete(workspace, resolved.id)
        // If the deleted session is the current one, clear the binding
        if (currentSessionId === resolved.id) {
          await clearSession(ctx.conversationKey)
        }
        return { content: `Session \`${resolved.id.slice(0, 8)}\` deleted.` }
      }

      // No arg — delete current session
      if (!currentSessionId) {
        return { content: 'No active session for this chat.', error: true }
      }
      await sessionService.delete(workspace, currentSessionId)
      await clearSession(ctx.conversationKey)
      return { content: `Session \`${currentSessionId.slice(0, 8)}\` deleted.` }
    }
  }
}

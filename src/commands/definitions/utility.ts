import type { ClaudePipeConfig } from '../../config/schema.js'
import type { ActiveTurnInfo } from '../../core/model-client.js'
import type { ClaudeSessionSummary } from '../../core/claude-sessions.js'
import type { CommandDefinition, CommandResult } from '../types.js'
import type { CommandRegistry } from '../registry.js'

/**
 * /help [command]
 * Lists all commands or shows detailed help for a specific command.
 */
export function helpCommand(registry: CommandRegistry): CommandDefinition {
  return {
    name: 'help',
    category: 'utility',
    description: 'Show available commands or help for a specific command',
    usage: '/help [command]',
    aliases: [],
    args: [{ name: 'command', description: 'Command name', required: false }],
    permission: 'user',
    async execute(ctx): Promise<CommandResult> {
      if (ctx.args.length > 0 && ctx.args[0]) {
        const target = registry.get(ctx.args[0])
        if (!target) {
          return { content: `Unknown command: \`${ctx.args[0]}\``, error: true }
        }
        const lines = [
          `**/${target.name}** — ${target.description}`,
          ...(target.usage ? [`Usage: ${target.usage}`] : []),
          ...(target.aliases && target.aliases.length > 0
            ? [`Aliases: ${target.aliases.map((a) => `/${a}`).join(', ')}`]
            : []),
          `Permission: ${target.permission}`
        ]
        return { content: lines.join('\n') }
      }

      const grouped = new Map<string, CommandDefinition[]>()
      for (const cmd of registry.all()) {
        const list = grouped.get(cmd.category) ?? []
        list.push(cmd)
        grouped.set(cmd.category, list)
      }

      const sections: string[] = []
      for (const [category, commands] of grouped) {
        const heading = category.charAt(0).toUpperCase() + category.slice(1)
        const items = commands.map((c) => `  /${c.name} — ${c.description}`)
        sections.push(`**${heading}:**\n${items.join('\n')}`)
      }

      return { content: sections.join('\n\n') }
    }
  }
}

/**
 * /status
 * Reports basic runtime status, current session info, and active turns.
 */
export function statusCommand(
  getStatus: (conversationKey: string) => Promise<{
    model: string
    workspace: string
    currentWorkspace: string
    channels: string[]
    sessionInfo: ClaudeSessionSummary | undefined
    activeTurns: ActiveTurnInfo[]
  }>
): CommandDefinition {
  return {
    name: 'status',
    category: 'utility',
    description: 'Show bot runtime status',
    aliases: [],
    permission: 'user',
    async execute(ctx): Promise<CommandResult> {
      const status = await getStatus(ctx.conversationKey)
      const lines = [
        '**Status:**',
        `• Model: ${status.model}`,
        `• Workspace: ${status.currentWorkspace}`,
        `• Default workspace: ${status.workspace}`,
        `• Channels: ${status.channels.join(', ')}`
      ]

      // Current session info
      if (status.sessionInfo) {
        const s = status.sessionInfo
        const shortId = s.sessionId.slice(0, 8)
        lines.push('', '**Session:**')
        lines.push(`• ID: ${shortId}`)
        lines.push(`• Topic: "${s.firstMessage}"`)
        lines.push(`• Model: ${s.model || 'unknown'}`)
        lines.push(`• Messages: ${s.userMessageCount} user / ${s.assistantMessageCount} assistant`)
        lines.push(`• Last active: ${s.lastActive || 'unknown'}`)
        if (s.gitBranch) {
          lines.push(`• Branch: ${s.gitBranch}`)
        }
      } else {
        lines.push('', 'No active session.')
      }

      // Active turns (running claude/codex processes)
      if (status.activeTurns.length > 0) {
        lines.push('', `**Running: ${status.activeTurns.length}**`)
        for (const turn of status.activeTurns) {
          const prompt = turn.prompt.length > 60 ? turn.prompt.slice(0, 60) + '…' : turn.prompt
          lines.push(`• ${turn.conversationKey} — "${prompt}"`)
        }
      } else {
        lines.push('', 'No active turns.')
      }

      return { content: lines.join('\n') }
    }
  }
}

/**
 * /reload
 * Reloads configuration from disk without restarting.
 */
export function reloadCommand(
  config: ClaudePipeConfig,
  reloadConfig: () => ClaudePipeConfig
): CommandDefinition {
  return {
    name: 'reload',
    category: 'utility',
    description: 'Reload configuration from disk',
    aliases: [],
    permission: 'admin',
    async execute(): Promise<CommandResult> {
      try {
        const fresh = reloadConfig()
        // Mutate the live config object in-place
        Object.assign(config, fresh)
        const parts = [
          'Configuration reloaded.',
          `- Model: ${config.model}`,
          `- Workspace: ${config.workspace}`
        ]
        if (config.personality?.name) {
          parts.push(`- Personality: ${config.personality.name} — ${config.personality.traits}`)
        }
        return { content: parts.join('\n') }
      } catch (error) {
        return {
          content: `Reload failed: ${error instanceof Error ? error.message : String(error)}`,
          error: true
        }
      }
    }
  }
}

/**
 * /ping
 * Simple health-check.
 */
export function pingCommand(): CommandDefinition {
  return {
    name: 'ping',
    category: 'utility',
    description: 'Health check — replies with pong',
    aliases: [],
    permission: 'user',
    async execute(): Promise<CommandResult> {
      return { content: 'pong 🏓' }
    }
  }
}

/**
 * /stop
 * Cancels the in-progress Claude turn for the current conversation.
 */
export function stopCommand(
  cancelTurn: (conversationKey: string) => void
): CommandDefinition {
  return {
    name: 'stop',
    category: 'utility',
    description: 'Cancel the in-progress Claude turn for this chat',
    aliases: ['cancel'],
    permission: 'user',
    async execute(ctx): Promise<CommandResult> {
      cancelTurn(ctx.conversationKey)
      return { content: 'Stopped.' }
    }
  }
}

/**
 * /restart
 * Restarts the bot process. Relies on a process manager (systemd, PM2, etc.) to bring it back up.
 */
export function restartCommand(): CommandDefinition {
  return {
    name: 'restart',
    category: 'utility',
    description: 'Restart the bot process',
    aliases: [],
    permission: 'admin',
    async execute(): Promise<CommandResult> {
      setImmediate(() => process.exit(0))
      return { content: 'Restarting...' }
    }
  }
}

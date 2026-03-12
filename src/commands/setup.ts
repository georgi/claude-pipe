import type { ClaudePipeConfig } from '../config/schema.js'
import { loadConfig } from '../config/load.js'
import type { ClaudeSessionService } from '../core/claude-sessions.js'
import type { ModelClient } from '../core/model-client.js'
import type { SessionStore } from '../core/session-store.js'
import { resolveWorkspace } from '../core/workspace.js'
import {
  sessionNewCommand,
  sessionListCommand,
  sessionSelectCommand,
  sessionDeleteCommand
} from './definitions/session.js'
import { helpCommand, statusCommand, pingCommand, reloadCommand, stopCommand, restartCommand } from './definitions/utility.js'
import { claudeAskCommand, claudeModelCommand } from './definitions/claude.js'
import { configSetCommand, configGetCommand } from './definitions/config.js'
import { CommandHandler } from './handler.js'
import { CommandRegistry } from './registry.js'
import type { CommandDefinition } from './types.js'

/**
 * Dependencies required by built-in commands.
 */
export interface CommandDependencies {
  config: ClaudePipeConfig
  claude: ModelClient
  sessionStore: SessionStore
  claudeSessionService: ClaudeSessionService
}

/**
 * Options for the command setup.
 */
export interface SetupCommandsOptions {
  /** Additional custom commands to register alongside built-ins. */
  customCommands?: CommandDefinition[]
  /** Sender IDs that have admin-level permission. */
  adminIds?: string[]
}

/**
 * Automatically registers all built-in commands and any custom commands,
 * then returns a ready-to-use {@link CommandHandler}.
 *
 * This replaces manual per-command wiring in the application bootstrap.
 */
export function setupCommands(
  deps: CommandDependencies,
  options: SetupCommandsOptions = {}
): { registry: CommandRegistry; handler: CommandHandler } {
  const { config, claude, sessionStore, claudeSessionService } = deps
  const registry = new CommandRegistry()
  const getWorkspace = (key: string): string => resolveWorkspace(config, key)

  // --- Session commands ---
  registry.register(sessionNewCommand((key) => claude.startNewSession(key)))
  registry.register(sessionListCommand(getWorkspace, claudeSessionService, (key) => sessionStore.get(key)?.sessionId))
  registry.register(
    sessionSelectCommand(getWorkspace, claudeSessionService, (key, sessionId) =>
      sessionStore.set(key, sessionId)
    )
  )
  registry.register(
    sessionDeleteCommand(getWorkspace, claudeSessionService, (key) => sessionStore.get(key)?.sessionId, (key) =>
      sessionStore.clear(key)
    )
  )

  // --- Claude commands ---
  registry.register(
    claudeAskCommand(async (conversationKey, prompt, channel, chatId) =>
      claude.runTurn(conversationKey, prompt, {
        workspace: resolveWorkspace(config, conversationKey),
        channel,
        chatId
      })
    )
  )
  registry.register(claudeModelCommand(() => config.model))

  // --- Config commands ---
  const mutableConfig: Record<string, string> = {}
  registry.register(
    configSetCommand((key, value) => {
      const allowed = ['summaryPromptEnabled']
      if (!allowed.includes(key)) return false
      mutableConfig[key] = value
      return true
    })
  )
  registry.register(
    configGetCommand((key) => {
      if (key) return mutableConfig[key]
      return { model: config.model, workspace: config.workspace, ...mutableConfig }
    })
  )

  // --- Utility commands ---
  registry.register(
    statusCommand(async (conversationKey) => {
      const currentWorkspace = resolveWorkspace(config, conversationKey)
      const currentSessionId = sessionStore.get(conversationKey)?.sessionId
      let sessionInfo = undefined
      if (currentSessionId) {
        sessionInfo = await claudeSessionService.get(currentWorkspace, currentSessionId) ?? undefined
      }
      return {
        model: config.model,
        workspace: config.workspace,
        currentWorkspace,
        channels: [
          ...(config.channels.telegram.enabled ? ['telegram'] : []),
          ...(config.channels.discord.enabled ? ['discord'] : []),
          ...(config.channels.cli?.enabled ? ['cli'] : [])
        ],
        sessionInfo,
        activeTurns: claude.getActiveTurns()
      }
    })
  )
  registry.register(pingCommand())
  registry.register(reloadCommand(config, loadConfig))
  registry.register(stopCommand((key) => claude.cancelTurn(key)))
  registry.register(restartCommand())

  // --- Custom commands ---
  for (const cmd of options.customCommands ?? []) {
    registry.register(cmd)
  }

  // Help must be registered last so it can list all commands including custom ones
  registry.register(helpCommand(registry))

  const adminIds = options.adminIds ?? [
    ...config.channels.telegram.allowFrom,
    ...config.channels.discord.allowFrom
  ]

  return { registry, handler: new CommandHandler(registry, adminIds) }
}

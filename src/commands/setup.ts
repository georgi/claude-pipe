import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PiPipeConfig } from '../config/schema.js'
import { loadConfig } from '../config/load.js'
import type { ModelClient } from '../core/model-client.js'
import { PiClient } from '../core/pi-client.js'
import type { SessionStore } from '../core/session-store.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
import {
  sessionNewCommand,
  sessionListCommand,
  sessionInfoCommand,
  sessionDeleteCommand
} from './definitions/session.js'
import {
  helpCommand,
  statusCommand,
  pingCommand,
  reloadCommand,
  stopCommand,
  restartCommand,
  hotReloadCommand
} from './definitions/utility.js'
import { piAskCommand, piModelCommand } from './definitions/pi.js'
import { configSetCommand, configGetCommand } from './definitions/config.js'
import { CommandHandler } from './handler.js'
import { CommandRegistry } from './registry.js'
import type { CommandDefinition } from './types.js'

/**
 * Dependencies required by built-in commands.
 */
export interface CommandDependencies {
  config: PiPipeConfig
  pi: ModelClient
  sessionStore: SessionStore
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
  const { config, pi, sessionStore } = deps
  const registry = new CommandRegistry()

  // --- Session commands ---
  registry.register(sessionNewCommand((key) => pi.startNewSession(key)))
  registry.register(
    sessionListCommand(() => {
      const map = sessionStore.entries()
      const result: Array<{ key: string; updatedAt: string }> = []
      for (const key of Object.keys(map)) {
        const record = map[key]
        if (record) result.push({ key, updatedAt: record.updatedAt })
      }
      return result
    })
  )
  registry.register(sessionInfoCommand((key) => sessionStore.get(key)))
  registry.register(sessionDeleteCommand((key) => pi.startNewSession(key)))

  // --- Pi commands ---
  registry.register(
    piAskCommand(async (conversationKey, prompt, channel, chatId) =>
      pi.runTurn(conversationKey, prompt, {
        workspace: config.workspace,
        channel,
        chatId
      })
    )
  )
  registry.register(
    piModelCommand(
      () => config.model,
      pi instanceof PiClient ? (model) => (pi as PiClient).setModel(model) : undefined
    )
  )

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
    statusCommand(() => ({
      model: config.model,
      workspace: config.workspace,
      channels: [
        ...(config.channels.telegram.enabled ? ['telegram'] : []),
        ...(config.channels.discord.enabled ? ['discord'] : []),
        ...(config.channels.cli?.enabled ? ['cli'] : [])
      ]
    }))
  )
  registry.register(pingCommand())
  registry.register(reloadCommand(config, loadConfig))
  registry.register(stopCommand((key) => pi.cancelTurn(key)))
  registry.register(restartCommand())
  registry.register(hotReloadCommand(projectRoot))

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

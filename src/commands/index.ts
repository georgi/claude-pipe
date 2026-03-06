export { CommandRegistry } from './registry.js'
export { CommandHandler } from './handler.js'
export { setupCommands } from './setup.js'
export type { CommandDependencies, SetupCommandsOptions } from './setup.js'
export type {
  CommandDefinition,
  CommandContext,
  CommandResult,
  CommandMeta,
  CommandCategory,
  PermissionLevel
} from './types.js'
export {
  sessionNewCommand,
  sessionListCommand,
  sessionInfoCommand,
  sessionDeleteCommand,
  helpCommand,
  statusCommand,
  pingCommand,
  reloadCommand,
  claudeAskCommand,
  claudeModelCommand,
  configSetCommand,
  configGetCommand
} from './definitions/index.js'

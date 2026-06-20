import * as path from 'node:path'

import { TelegramChannel } from './channels/telegram.js'
import { ChannelManager } from './channels/manager.js'
import { setupCommands } from './commands/index.js'
import { discoverSkills } from './commands/skills.js'
import { loadConfig } from './config/load.js'
import { readSettings, settingsExist } from './config/settings.js'
import { AgentLoop } from './core/agent-loop.js'
import { MessageBus } from './core/bus.js'
import { createModelClient } from './core/client-factory.js'
import { createHeartbeat } from './core/heartbeat.js'
import { logger, setLoggerMuted } from './core/logger.js'
import { SessionStore } from './core/session-store.js'
import { DailyLog } from './memory/daily-log.js'
import { MemoryStore } from './memory/store.js'
import { runOnboarding } from './onboarding/wizard.js'

/** Check if --reconfigure flag was passed */
function isReconfigureMode(): boolean {
  return process.argv.includes('--reconfigure') || process.argv.includes('-r')
}

/** Check if --help flag was passed */
function isHelpMode(): boolean {
  return process.argv.includes('--help') || process.argv.includes('-h')
}

/** Show help message */
function showHelp(): void {
  console.log(
    '\nPi Pipe - Bot for Telegram and Discord using the Pi Coding Agent SDK\n\n' +
      'Usage:\n' +
      '  npm run dev [-- options]   Start the bot in development mode (tsx)\n' +
      '  npm start [-- options]     Start the compiled build (node dist/index.js)\n\n' +
      'Options:\n' +
      '  --reconfigure, -r  Reconfigure existing settings\n' +
      '  --help, -h         Show this help message\n\n' +
      'Examples:\n' +
      '  npm run dev               Start the bot\n' +
      '  npm run dev -- -r         Reconfigure settings\n'
  )
}

/** Boots the Pi Pipe runtime and starts channel + agent loops. */
async function main(): Promise<void> {
  // Handle help mode
  if (isHelpMode()) {
    showHelp()
    return
  }

  // Handle reconfigure mode
  if (isReconfigureMode()) {
    if (!settingsExist()) {
      console.error('No settings found. Run onboarding first.')
      process.exit(1)
    }
    const existingSettings = readSettings()
    await runOnboarding(existingSettings)
    return
  }

  // Handle first-time setup
  if (!settingsExist()) {
    await runOnboarding()
    return
  }

  // Normal startup
  const config = loadConfig()
  if (config.channels.cli?.enabled) {
    setLoggerMuted(true)
  }
  const bus = new MessageBus()

  const sessionStore = new SessionStore(config.sessionStorePath)
  await sessionStore.init()

  // Persistent memory is optional. Paths from the config are resolved relative
  // to the workspace when not absolute so a portable settings file still lands
  // its data under the active workspace.
  const resolveWorkspacePath = (p: string): string =>
    path.isAbsolute(p) ? p : path.join(config.workspace, p)

  let memoryStore: MemoryStore | null = null
  let dailyLog: DailyLog | null = null
  if (config.memory.enabled) {
    memoryStore = new MemoryStore(resolveWorkspacePath(config.memory.dbPath))
    memoryStore.init()
    dailyLog = new DailyLog(resolveWorkspacePath(config.memory.dailyLogPath))
  }

  logger.info('startup.config', {
    workspace: config.workspace,
    model: config.model,
    sandbox: config.sandbox
  })

  // Warn loudly when a network-facing channel is wide open: an empty allowFrom
  // means anyone who finds the bot can drive its tools.
  const warnOpenAllowlist = (name: string, enabled: boolean, allowFrom: string[]): void => {
    if (enabled && allowFrom.length === 0) {
      logger.warn('security.open_allowlist', {
        channel: name,
        message: `${name} is enabled with an empty allowFrom list — every sender is allowed.`
      })
    }
  }
  warnOpenAllowlist(
    'telegram',
    config.channels.telegram.enabled,
    config.channels.telegram.allowFrom
  )
  warnOpenAllowlist('discord', config.channels.discord.enabled, config.channels.discord.allowFrom)

  const modelClient = createModelClient(config, sessionStore, logger)
  const agent = new AgentLoop(bus, config, modelClient, logger)
  const channels = new ChannelManager(config, bus, logger)
  const heartbeat = createHeartbeat(config, bus, logger)

  const { handler, registry } = setupCommands({ config, pi: modelClient, sessionStore })
  agent.setCommandHandler(handler)
  agent.setChannelManager(channels)
  if (memoryStore && dailyLog) {
    agent.setMemory(memoryStore, dailyLog)
  }

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('shutdown.signal', { signal })
    memoryStore?.close()
    heartbeat.stop()
    agent.stop()
    // Force exit after 2 s in case channel pollers are slow to stop
    setTimeout(() => process.exit(0), 2000).unref()
    void channels.stopAll().then(() => process.exit(0))
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  await channels.startAll()

  // Register user-invocable skills as Telegram bot commands
  if (config.channels.telegram.enabled && config.channels.telegram.token) {
    const skills = discoverSkills()
    if (skills.length > 0) {
      const builtinMeta = registry.toMeta()
      const skillCommands = skills.map((s) => ({
        command: s.name.replace(/-/g, '_'),
        description: s.description
      }))
      const builtinCommands = builtinMeta.map((m) => ({
        command: m.telegramName,
        description: m.description
      }))
      const allCommands = [...builtinCommands, ...skillCommands].slice(0, 100) // Telegram limit
      await TelegramChannel.registerBotCommands(
        config.channels.telegram.token,
        allCommands.map((c) => ({
          name: c.command,
          description: c.description,
          category: 'utility' as const,
          telegramName: c.command
        })),
        logger
      )
      logger.info('startup.skills_registered', {
        count: skillCommands.length,
        names: skills.map((s) => s.name)
      })
    }
  }

  // Start the heartbeat before the agent's blocking consume loop — `agent.start()`
  // never returns while running, so anything after it would be dead code.
  heartbeat.start()
  await agent.start()
}

// Last-resort handlers so a stray throw/rejection from a channel callback or
// fire-and-forget task is logged through the structured logger instead of
// crashing silently. An uncaught exception leaves the process in an unknown
// state, so we exit; a stray rejection is logged but tolerated.
process.on('uncaughtException', (error: Error) => {
  logger.error('fatal.uncaught_exception', {
    error: error.message,
    ...(error.stack ? { stack: error.stack } : {})
  })
  process.exit(1)
})
process.on('unhandledRejection', (reason: unknown) => {
  logger.error('fatal.unhandled_rejection', {
    error: reason instanceof Error ? reason.message : String(reason)
  })
})

main().catch((error: unknown) => {
  logger.error('fatal', {
    error: error instanceof Error ? error.message : String(error)
  })
  process.exitCode = 1
})

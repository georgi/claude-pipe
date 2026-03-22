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
    '\nClaude Pipe - Bot for Telegram and Discord using Claude Code CLI\n\n' +
      'Usage: claude-pipe [options]\n\n' +
      'Options:\n' +
      '  --reconfigure, -r  Reconfigure existing settings\n' +
      '  --help, -h         Show this help message\n\n' +
      'Examples:\n' +
      '  claude-pipe           Start the bot\n' +
      '  claude-pipe -r        Reconfigure settings\n'
  )
}

/** Boots the Claude Pipe runtime and starts channel + agent loops. */
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

  const dataDir = `${config.workspace}/data`
  const memoryStore = new MemoryStore(`${dataDir}/memory.db`)
  memoryStore.init()
  const dailyLog = new DailyLog(`${dataDir}/daily-logs`)

  logger.info('startup.config', {
    workspace: config.workspace,
    model: config.model
  })

  const modelClient = createModelClient(config, sessionStore, logger)
  const agent = new AgentLoop(bus, config, modelClient, logger)
  const channels = new ChannelManager(config, bus, logger)
  const heartbeat = createHeartbeat(config, bus, logger)

  const { handler } = setupCommands({ config, claude: modelClient, sessionStore })
  agent.setCommandHandler(handler)
  agent.setChannelManager(channels)
  agent.setMemory(memoryStore, dailyLog)

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('shutdown.signal', { signal })
    memoryStore.close()
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
      const { registry } = setupCommands({ config, claude: modelClient, sessionStore })
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

  await agent.start()
  heartbeat.start()
}

main().catch((error: unknown) => {
  logger.error('fatal', {
    error: error instanceof Error ? error.message : String(error)
  })
  process.exitCode = 1
})

import { DiscordChannel } from './channels/discord.js'
import { setupCommands } from './commands/index.js'
import { loadConfig } from './config/load.js'
import { settingsExist } from './config/settings.js'
import { logger } from './core/logger.js'

const applicationId = process.argv[2]

if (!applicationId) {
  console.error('Usage: npm run register <discord-application-id>')
  process.exit(1)
}

if (!settingsExist()) {
  console.error('No settings found. Run onboarding first: npm run dev')
  process.exit(1)
}

const config = loadConfig()

if (!config.channels.discord.enabled) {
  console.error('Discord is not enabled in settings.')
  process.exit(1)
}

const { registry } = setupCommands({ config, claude: null!, sessionStore: null! })

await DiscordChannel.registerSlashCommands(
  config.channels.discord.token,
  applicationId,
  registry.toMeta(),
  logger
)

console.log('Discord slash commands registered successfully.')

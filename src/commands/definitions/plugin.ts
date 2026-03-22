import type { CommandDefinition, CommandResult } from '../types.js'
import {
  getMarketplaces,
  searchPlugins,
  findPlugin,
  installPlugin,
  listInstalledPlugins,
  removePlugin,
  isPluginInstalled
} from '../../plugins/index.js'

/**
 * /plugins
 * Lists available plugin marketplaces and installed plugins.
 */
export function pluginsCommand(): CommandDefinition {
  return {
    name: 'plugins',
    category: 'plugin',
    description: 'List plugin marketplaces and installed plugins',
    usage: '/plugins',
    aliases: ['marketplace'],
    permission: 'user',
    async execute(): Promise<CommandResult> {
      const marketplaces = getMarketplaces()
      const installed = listInstalledPlugins()

      const lines: string[] = ['**Plugin Marketplaces:**']
      for (const m of marketplaces) {
        lines.push(`\n**${m.name}** (${m.plugins.length} plugins)`)
        lines.push(`  ${m.url}`)
        for (const p of m.plugins) {
          const badge = isPluginInstalled(p.id) ? ' [installed]' : ''
          lines.push(`  • \`${p.id}\` — ${p.description}${badge}`)
        }
      }

      if (installed.length > 0) {
        lines.push('\n**Installed Plugins:**')
        for (const p of installed) {
          lines.push(`  • **${p.name}** (\`${p.id}\`) — installed ${p.installedAt.split('T')[0]}`)
        }
      }

      lines.push('\nUse `/plugin_search <query>` to search, `/plugin_install <id>` to install.')

      return { content: lines.join('\n') }
    }
  }
}

/**
 * /plugin_search <query>
 * Search for plugins by name, description, or tags.
 */
export function pluginSearchCommand(): CommandDefinition {
  return {
    name: 'plugin_search',
    category: 'plugin',
    description: 'Search plugins by name, description, or tags',
    usage: '/plugin_search <query>',
    aliases: ['psearch'],
    permission: 'user',
    async execute(ctx): Promise<CommandResult> {
      const query = ctx.rawArgs.trim()
      if (!query) {
        return { content: 'Usage: `/plugin_search <query>`\nExample: `/plugin_search database`', error: true }
      }

      const results = searchPlugins(query)
      if (results.length === 0) {
        return { content: `No plugins found for "${query}". Try a broader search.` }
      }

      const lines = [`**Search results for "${query}"** (${results.length} found):\n`]
      for (const p of results) {
        const badge = isPluginInstalled(p.id) ? ' [installed]' : ''
        lines.push(`• **${p.name}** (\`${p.id}\`)${badge}`)
        lines.push(`  ${p.description}`)
        lines.push(`  Source: ${p.source} | Tags: ${p.tags.join(', ')}`)
      }

      lines.push('\nInstall with: `/plugin_install <id>`')

      return { content: lines.join('\n') }
    }
  }
}

/**
 * /plugin_install <id>
 * Install a plugin from the marketplace.
 */
export function pluginInstallCommand(): CommandDefinition {
  return {
    name: 'plugin_install',
    category: 'plugin',
    description: 'Install a plugin from the marketplace',
    usage: '/plugin_install <plugin-id>',
    aliases: ['pinstall'],
    permission: 'admin',
    async execute(ctx): Promise<CommandResult> {
      const id = ctx.rawArgs.trim()
      if (!id) {
        return {
          content: 'Usage: `/plugin_install <plugin-id>`\nExample: `/plugin_install anthropic/github`',
          error: true
        }
      }

      const entry = findPlugin(id)
      if (!entry) {
        return {
          content: `Plugin "${id}" not found. Use \`/plugin_search\` to find available plugins.`,
          error: true
        }
      }

      if (isPluginInstalled(entry.id)) {
        return {
          content: `Plugin "${entry.name}" is already installed. Use \`/plugin_remove ${entry.id}\` first to reinstall.`,
          error: true
        }
      }

      try {
        const installed = installPlugin(entry)
        return {
          content:
            `**Installed "${installed.name}"**\n` +
            `• ID: \`${installed.id}\`\n` +
            `• Path: \`${installed.path}\`\n` +
            `• Source: ${installed.source}\n\n` +
            `Plugin is ready to use.`
        }
      } catch (error) {
        return {
          content: `Failed to install "${entry.name}": ${error instanceof Error ? error.message : String(error)}`,
          error: true
        }
      }
    }
  }
}

/**
 * /plugin_remove <id>
 * Remove an installed plugin.
 */
export function pluginRemoveCommand(): CommandDefinition {
  return {
    name: 'plugin_remove',
    category: 'plugin',
    description: 'Remove an installed plugin',
    usage: '/plugin_remove <plugin-id-or-name>',
    aliases: ['premove', 'plugin_uninstall'],
    permission: 'admin',
    async execute(ctx): Promise<CommandResult> {
      const id = ctx.rawArgs.trim()
      if (!id) {
        return {
          content: 'Usage: `/plugin_remove <plugin-id-or-name>`\nExample: `/plugin_remove anthropic/github`',
          error: true
        }
      }

      const removed = removePlugin(id)
      if (!removed) {
        return { content: `Plugin "${id}" is not installed.`, error: true }
      }

      return { content: `Plugin "${id}" has been removed.` }
    }
  }
}

/**
 * /plugin_info <id>
 * Show detailed info about a plugin.
 */
export function pluginInfoCommand(): CommandDefinition {
  return {
    name: 'plugin_info',
    category: 'plugin',
    description: 'Show detailed info about a plugin',
    usage: '/plugin_info <plugin-id>',
    aliases: ['pinfo'],
    permission: 'user',
    async execute(ctx): Promise<CommandResult> {
      const id = ctx.rawArgs.trim()
      if (!id) {
        return { content: 'Usage: `/plugin_info <plugin-id>`', error: true }
      }

      const entry = findPlugin(id)
      if (!entry) {
        return { content: `Plugin "${id}" not found.`, error: true }
      }

      const installed = isPluginInstalled(entry.id)
      const installCmd =
        entry.install.type === 'npm'
          ? `npm: ${entry.install.package}`
          : entry.install.type === 'npx'
            ? `npx: ${entry.install.command}`
            : `git: ${entry.install.url}`

      const lines = [
        `**${entry.name}** (\`${entry.id}\`)`,
        `${entry.description}`,
        '',
        `• Source: ${entry.source}`,
        `• Install method: ${installCmd}`,
        `• Tags: ${entry.tags.join(', ')}`,
        `• Status: ${installed ? 'Installed' : 'Not installed'}`,
        '',
        installed
          ? `Remove with: \`/plugin_remove ${entry.id}\``
          : `Install with: \`/plugin_install ${entry.id}\``
      ]

      return { content: lines.join('\n') }
    }
  }
}

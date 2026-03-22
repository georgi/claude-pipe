/**
 * Plugin installer.
 *
 * Handles installing, listing, and removing plugins.
 * Plugins are installed as MCP servers or skills under ~/.claude-pipe/plugins/.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'
import type { PluginEntry, PluginInstallMethod } from './marketplace.js'

const PLUGINS_DIR = join(homedir(), '.claude-pipe', 'plugins')
const MANIFEST_FILE = 'plugin.json'

export interface InstalledPlugin {
  id: string
  name: string
  description: string
  source: string
  install: PluginInstallMethod
  installedAt: string
  path: string
}

/** Ensure the plugins directory exists. */
function ensurePluginsDir(): void {
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true })
  }
}

/** Returns the directory for a specific plugin. */
function pluginDir(entry: PluginEntry): string {
  // Use a safe directory name from the plugin id
  const safeName = entry.id.replace(/\//g, '__')
  return join(PLUGINS_DIR, safeName)
}

/**
 * Install a plugin from the marketplace.
 * Returns the installed plugin info or throws on failure.
 */
export function installPlugin(entry: PluginEntry): InstalledPlugin {
  ensurePluginsDir()

  const dir = pluginDir(entry)
  if (existsSync(dir)) {
    throw new Error(`Plugin "${entry.name}" is already installed. Remove it first with /plugin_remove.`)
  }

  mkdirSync(dir, { recursive: true })

  try {
    switch (entry.install.type) {
      case 'npm':
        execSync(`npm install --prefix "${dir}" ${entry.install.package}`, {
          stdio: 'pipe',
          timeout: 120_000
        })
        break

      case 'npx':
        // For npx-based plugins, we install the package locally so it's available offline
        execSync(`npm install --prefix "${dir}" ${entry.install.command}`, {
          stdio: 'pipe',
          timeout: 120_000
        })
        break

      case 'git':
        execSync(`git clone --depth 1 "${entry.install.url}" "${dir}"`, {
          stdio: 'pipe',
          timeout: 120_000
        })
        // Install dependencies if package.json exists
        if (existsSync(join(dir, 'package.json'))) {
          execSync('npm install', { cwd: dir, stdio: 'pipe', timeout: 120_000 })
        }
        break
    }
  } catch (error) {
    // Clean up on failure
    rmSync(dir, { recursive: true, force: true })
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to install "${entry.name}": ${msg}`)
  }

  const installed: InstalledPlugin = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    source: entry.source,
    install: entry.install,
    installedAt: new Date().toISOString(),
    path: dir
  }

  // Write manifest for tracking
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(installed, null, 2))

  return installed
}

/** List all installed plugins. */
export function listInstalledPlugins(): InstalledPlugin[] {
  ensurePluginsDir()
  const plugins: InstalledPlugin[] = []

  for (const entry of readdirSync(PLUGINS_DIR)) {
    const manifest = join(PLUGINS_DIR, entry, MANIFEST_FILE)
    if (!existsSync(manifest)) continue

    try {
      const data = JSON.parse(readFileSync(manifest, 'utf8')) as InstalledPlugin
      data.path = join(PLUGINS_DIR, entry)
      plugins.push(data)
    } catch {
      // Skip corrupted manifests
    }
  }

  return plugins
}

/** Check if a plugin is installed. */
export function isPluginInstalled(id: string): boolean {
  return listInstalledPlugins().some((p) => p.id === id)
}

/** Remove an installed plugin by id or name. */
export function removePlugin(idOrName: string): boolean {
  const plugins = listInstalledPlugins()
  const target = plugins.find(
    (p) => p.id === idOrName || p.name.toLowerCase() === idOrName.toLowerCase()
  )

  if (!target) return false

  rmSync(target.path, { recursive: true, force: true })
  return true
}

/** Get the run command for an installed plugin. */
export function getPluginRunCommand(plugin: InstalledPlugin): string {
  switch (plugin.install.type) {
    case 'npx':
      return `npx --prefix "${plugin.path}" ${plugin.install.command}`
    case 'npm':
      return `node "${join(plugin.path, 'node_modules', plugin.install.package, 'index.js')}"`
    case 'git':
      return `node "${join(plugin.path, 'index.js')}"`
  }
}

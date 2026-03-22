import { describe, expect, it, vi } from 'vitest'

import { setupCommands } from '../src/commands/setup.js'
import type { CommandDependencies } from '../src/commands/setup.js'
import type { CommandDefinition } from '../src/commands/types.js'
import type { ClaudePipeConfig } from '../src/config/schema.js'

function makeDeps(): CommandDependencies {
  const config: ClaudePipeConfig = {
    model: 'claude-sonnet-4-5',
    workspace: '/tmp/workspace',
    channels: {
      telegram: { enabled: true, token: 'tg-token', allowFrom: ['admin1'] },
      discord: { enabled: true, token: 'dc-token', allowFrom: ['admin2'] }
    },
    tools: { execTimeoutSec: 60 },
    summaryPrompt: { enabled: true, template: 'Workspace: {{workspace}} Request: {{request}}' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20
  }

  const claude = {
    startNewSession: vi.fn(async () => undefined),
    runTurn: vi.fn(async () => 'claude reply'),
    closeAll: vi.fn()
  }

  const sessionStore = {
    get: vi.fn(() => undefined),
    entries: vi.fn(() => ({})),
    set: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    init: vi.fn(async () => undefined)
  }

  return { config, claude: claude as never, sessionStore: sessionStore as never }
}

describe('setupCommands', () => {
  it('registers all built-in commands automatically', () => {
    const { registry } = setupCommands(makeDeps())

    const names = registry
      .all()
      .map((c) => c.name)
      .sort()
    expect(names).toContain('session_new')
    expect(names).toContain('session_list')
    expect(names).toContain('session_info')
    expect(names).toContain('session_delete')
    expect(names).toContain('claude_ask')
    expect(names).toContain('claude_model')
    expect(names).toContain('config_set')
    expect(names).toContain('config_get')
    expect(names).toContain('status')
    expect(names).toContain('ping')
    expect(names).toContain('help')
  })

  it('registers custom commands alongside built-ins', () => {
    const custom: CommandDefinition = {
      name: 'deploy',
      category: 'utility',
      description: 'Deploy to production',
      aliases: ['ship'],
      permission: 'admin',
      async execute() {
        return { content: 'Deployed!' }
      }
    }

    const { registry, handler } = setupCommands(makeDeps(), {
      customCommands: [custom]
    })

    expect(registry.has('deploy')).toBe(true)
    expect(registry.has('ship')).toBe(true)
    // Custom command is visible in help
    expect(registry.all().find((c) => c.name === 'deploy')).toBeDefined()
    // Handler is functional
    expect(handler.isCommand('/deploy')).toBe(true)
  })

  it('derives admin IDs from config allowFrom by default', async () => {
    const { handler } = setupCommands(makeDeps())

    // admin1 (from telegram allowFrom) can run admin commands
    const result = await handler.execute('/session_list', 'telegram', '42', 'admin1')
    expect(result).not.toBeNull()
    expect(result?.error).toBeUndefined()

    // unknown user gets denied
    const denied = await handler.execute('/session_list', 'telegram', '42', 'unknown')
    expect(denied?.error).toBe(true)
  })

  it('accepts explicit admin IDs override', async () => {
    const { handler } = setupCommands(makeDeps(), { adminIds: ['custom-admin'] })

    const result = await handler.execute('/session_list', 'telegram', '42', 'custom-admin')
    expect(result?.error).toBeUndefined()

    // Default allowFrom users no longer have admin
    const denied = await handler.execute('/session_list', 'telegram', '42', 'admin1')
    expect(denied?.error).toBe(true)
  })

  it('handler recognises aliases for built-in commands', () => {
    const { handler } = setupCommands(makeDeps())

    expect(handler.isCommand('/new')).toBe(true)
    expect(handler.isCommand('/reset')).toBe(true)
    expect(handler.isCommand('/ask')).toBe(true)
    expect(handler.isCommand('/model')).toBe(true)
  })

  it('claude_ask command invokes claude.runTurn', async () => {
    const deps = makeDeps()
    const { handler } = setupCommands(deps)

    const result = await handler.execute('/claude_ask hello world', 'telegram', '42', 'admin1')
    expect(result?.content).toBe('claude reply')
    expect((deps.claude as any).runTurn).toHaveBeenCalled()
  })
})

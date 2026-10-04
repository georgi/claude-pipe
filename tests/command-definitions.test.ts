import { describe, expect, it, vi } from 'vitest'

import {
  sessionNewCommand,
  sessionListCommand,
  sessionInfoCommand,
  sessionDeleteCommand,
  helpCommand,
  statusCommand,
  pingCommand,
  piAskCommand,
  piModelCommand,
  configSetCommand,
  configGetCommand,
  CommandRegistry
} from '../src/commands/index.js'
import type { CommandContext } from '../src/commands/types.js'

function makeCtx(overrides?: Partial<CommandContext>): CommandContext {
  return {
    channel: 'telegram',
    chatId: '42',
    senderId: 'u1',
    conversationKey: 'telegram:42',
    args: [],
    rawArgs: '',
    ...overrides
  }
}

describe('Session commands', () => {
  it('/session_new calls startNewSession and returns confirmation', async () => {
    const startNew = vi.fn(async () => undefined)
    const cmd = sessionNewCommand(startNew)

    const result = await cmd.execute(makeCtx())
    expect(result.content).toBe('Started a new session for this chat.')
    expect(startNew).toHaveBeenCalledWith('telegram:42')
  })

  it('/session_list returns session listing', async () => {
    const cmd = sessionListCommand(() => [
      { key: 'telegram:42', updatedAt: '2025-01-01T00:00:00Z' }
    ])

    const result = await cmd.execute(makeCtx())
    expect(result.content).toContain('Active sessions (1)')
    expect(result.content).toContain('telegram:42')
  })

  it('/session_list returns empty message when no sessions', async () => {
    const cmd = sessionListCommand(() => [])
    const result = await cmd.execute(makeCtx())
    expect(result.content).toBe('No active sessions.')
  })

  it('/session_info is admin-only and shows only the session file basename', async () => {
    const cmd = sessionInfoCommand(() => ({
      sessionFile: '/Users/secret-user/private-workspace/.pi/sessions/sess-abc.jsonl',
      updatedAt: '2025-01-01T00:00:00Z'
    }))

    expect(cmd.permission).toBe('admin')

    const result = await cmd.execute(makeCtx())
    expect(result.content).toContain('sess-abc.jsonl')
    expect(result.content).toContain('Session info')
    // The full path must not leak via the message content
    expect(result.content).not.toContain('/Users/secret-user')
    expect(result.content).not.toContain('private-workspace')
  })

  it('/session_info returns no-session message', async () => {
    const cmd = sessionInfoCommand(() => undefined)
    const result = await cmd.execute(makeCtx())
    expect(result.content).toBe('No active session for this chat.')
  })

  it('/session_delete calls delete and confirms', async () => {
    const deleteFn = vi.fn(async () => undefined)
    const cmd = sessionDeleteCommand(deleteFn)

    const result = await cmd.execute(makeCtx())
    expect(result.content).toBe('Session deleted for this chat.')
    expect(deleteFn).toHaveBeenCalledWith('telegram:42')
  })
})

describe('Utility commands', () => {
  it('/help lists all registered commands', async () => {
    const registry = new CommandRegistry()
    registry.register(pingCommand())
    registry.register(statusCommand(() => ({ model: 'm', workspace: '/w', channels: [] })))
    const cmd = helpCommand(registry)
    registry.register(cmd)

    const result = await cmd.execute(makeCtx())
    expect(result.content).toContain('/ping')
    expect(result.content).toContain('/status')
    expect(result.content).toContain('/help')
  })

  it('/help <command> shows specific command details', async () => {
    const registry = new CommandRegistry()
    const ping = pingCommand()
    registry.register(ping)
    const cmd = helpCommand(registry)
    registry.register(cmd)

    const result = await cmd.execute(makeCtx({ args: ['ping'], rawArgs: 'ping' }))
    expect(result.content).toContain('/ping')
    expect(result.content).toContain('Health check')
  })

  it('/help <unknown> returns error', async () => {
    const registry = new CommandRegistry()
    const cmd = helpCommand(registry)
    registry.register(cmd)

    const result = await cmd.execute(makeCtx({ args: ['nonexistent'], rawArgs: 'nonexistent' }))
    expect(result.error).toBe(true)
    expect(result.content).toContain('Unknown command')
  })

  it('/status reports runtime info', async () => {
    const cmd = statusCommand(() => ({
      model: 'claude-sonnet-4-5',
      workspace: '/tmp/test',
      channels: ['telegram', 'discord']
    }))

    const result = await cmd.execute(makeCtx())
    expect(result.content).toContain('claude-sonnet-4-5')
    expect(result.content).toContain('/tmp/test')
    expect(result.content).toContain('telegram, discord')
  })

  it('/ping returns pong', async () => {
    const cmd = pingCommand()
    const result = await cmd.execute(makeCtx())
    expect(result.content).toBe('pong 🏓')
  })
})

describe('Pi commands', () => {
  it('/pi_ask sends prompt and returns reply', async () => {
    const runTurn = vi.fn(async () => 'Pi says hello')
    const cmd = piAskCommand(runTurn)

    const result = await cmd.execute(makeCtx({ rawArgs: 'hello world', args: ['hello', 'world'] }))
    expect(result.content).toBe('Pi says hello')
    expect(runTurn).toHaveBeenCalledWith('telegram:42', 'hello world', 'telegram', '42')
  })

  it('/pi_ask with no prompt returns usage error', async () => {
    const cmd = piAskCommand(vi.fn())
    const result = await cmd.execute(makeCtx())
    expect(result.error).toBe(true)
    expect(result.content).toContain('Usage')
  })

  it('/pi_model with no args shows current model', async () => {
    const cmd = piModelCommand(() => 'claude-sonnet-4-5')
    const result = await cmd.execute(makeCtx())
    expect(result.content).toContain('claude-sonnet-4-5')
  })

  it('/pi_model with arg switches model', async () => {
    const setModel = vi.fn()
    const cmd = piModelCommand(() => 'old-model', setModel)

    const result = await cmd.execute(makeCtx({ args: ['new-model'], rawArgs: 'new-model' }))
    expect(result.content).toContain('new-model')
    expect(setModel).toHaveBeenCalledWith('new-model')
  })
})

describe('Config commands', () => {
  it('/config_set updates a valid key', async () => {
    const setter = vi.fn(() => true)
    const cmd = configSetCommand(setter)

    const result = await cmd.execute(makeCtx({ args: ['key', 'value'], rawArgs: 'key value' }))
    expect(result.content).toContain('key')
    expect(result.content).toContain('value')
    expect(setter).toHaveBeenCalledWith('key', 'value')
  })

  it('/config_set rejects unknown key', async () => {
    const cmd = configSetCommand(() => false)
    const result = await cmd.execute(makeCtx({ args: ['bad', 'val'], rawArgs: 'bad val' }))
    expect(result.error).toBe(true)
  })

  it('/config_set with missing args returns usage', async () => {
    const cmd = configSetCommand(() => true)
    const result = await cmd.execute(makeCtx())
    expect(result.error).toBe(true)
    expect(result.content).toContain('Usage')
  })

  it('/config_get shows all config', async () => {
    const cmd = configGetCommand(() => ({ model: 'test', workspace: '/tmp' }))
    const result = await cmd.execute(makeCtx())
    expect(result.content).toContain('model')
    expect(result.content).toContain('workspace')
  })

  it('/config_get with key shows specific value', async () => {
    const cmd = configGetCommand((key) => (key === 'model' ? 'test-model' : undefined))
    const result = await cmd.execute(makeCtx({ args: ['model'], rawArgs: 'model' }))
    expect(result.content).toContain('test-model')
  })

  it('/config_get with unknown key returns error', async () => {
    const cmd = configGetCommand(() => undefined)
    const result = await cmd.execute(makeCtx({ args: ['bad'], rawArgs: 'bad' }))
    expect(result.error).toBe(true)
  })

  it('/config_get with no key returning a string handles the empty key formatter', async () => {
    const cmd = configGetCommand(() => 'just-a-string')
    const result = await cmd.execute(makeCtx())
    expect(result.error).toBeUndefined()
    expect(result.content).toContain('just-a-string')
  })

  it('/config_get with no key returning undefined still surfaces an error', async () => {
    const cmd = configGetCommand(() => undefined)
    const result = await cmd.execute(makeCtx())
    expect(result.error).toBe(true)
  })
})

describe('Pi commands edge paths', () => {
  it('/pi_model with arg but no setter is rejected', async () => {
    const cmd = piModelCommand(() => 'current-model') // no second arg = no setter
    const result = await cmd.execute(makeCtx({ args: ['new-model'], rawArgs: 'new-model' }))
    expect(result.error).toBe(true)
    expect(result.content).toContain('not supported')
  })
})

describe('helpCommand edge paths', () => {
  it('renders a command with no usage and no aliases', async () => {
    const { CommandRegistry } = await import('../src/commands/index.js')
    const { helpCommand } = await import('../src/commands/definitions/utility.js')
    const registry = new CommandRegistry()
    registry.register({
      name: 'bare',
      category: 'utility',
      description: 'A bare command',
      permission: 'user',
      async execute() {
        return { content: '' }
      }
    })
    const help = helpCommand(registry)
    registry.register(help)
    const result = await help.execute(makeCtx({ args: ['bare'], rawArgs: 'bare' }))
    expect(result.content).toContain('/bare')
    expect(result.content).not.toContain('Usage:')
    expect(result.content).not.toContain('Aliases:')
  })
})

import { describe, expect, it, vi } from 'vitest'

import {
  sessionNewCommand,
  sessionListCommand,
  sessionInfoCommand,
  sessionDeleteCommand,
  helpCommand,
  statusCommand,
  pingCommand,
  claudeAskCommand,
  claudeModelCommand,
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

  it('/session_info returns session details', async () => {
    const cmd = sessionInfoCommand(() => ({
      sessionId: 'sess-abc',
      updatedAt: '2025-01-01T00:00:00Z'
    }))

    const result = await cmd.execute(makeCtx())
    expect(result.content).toContain('sess-abc')
    expect(result.content).toContain('Session info')
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

describe('Claude commands', () => {
  it('/claude_ask sends prompt and returns reply', async () => {
    const runTurn = vi.fn(async () => 'Claude says hello')
    const cmd = claudeAskCommand(runTurn)

    const result = await cmd.execute(makeCtx({ rawArgs: 'hello world', args: ['hello', 'world'] }))
    expect(result.content).toBe('Claude says hello')
    expect(runTurn).toHaveBeenCalledWith('telegram:42', 'hello world', 'telegram', '42')
  })

  it('/claude_ask with no prompt returns usage error', async () => {
    const cmd = claudeAskCommand(vi.fn())
    const result = await cmd.execute(makeCtx())
    expect(result.error).toBe(true)
    expect(result.content).toContain('Usage')
  })

  it('/claude_model with no args shows current model', async () => {
    const cmd = claudeModelCommand(() => 'claude-sonnet-4-5')
    const result = await cmd.execute(makeCtx())
    expect(result.content).toContain('claude-sonnet-4-5')
  })

  it('/claude_model with arg switches model', async () => {
    const setModel = vi.fn()
    const cmd = claudeModelCommand(() => 'old-model', setModel)

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
})

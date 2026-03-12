import { describe, expect, it, vi } from 'vitest'

import {
  sessionNewCommand,
  sessionListCommand,
  sessionSelectCommand,

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
import type { ClaudeSessionService, ClaudeSessionSummary } from '../src/core/claude-sessions.js'
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

const sampleSession: ClaudeSessionSummary = {
  sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
  firstMessage: 'fix the login bug',
  model: 'claude-opus-4-6',
  lastActive: '2026-03-12T03:43:07.526Z',
  gitBranch: 'main',
  userMessageCount: 5,
  assistantMessageCount: 30
}

function mockSessionService(sessions: ClaudeSessionSummary[] = [sampleSession]): ClaudeSessionService {
  return {
    list: vi.fn(async () => sessions),
    get: vi.fn(async (_ws, id) => sessions.find((s) => s.sessionId === id || s.sessionId.startsWith(id))),
    resolve: vi.fn(async (_ws, prefix) => {
      const matches = sessions.filter((s) => s.sessionId.startsWith(prefix))
      if (matches.length === 1) return { id: matches[0]!.sessionId }
      if (matches.length === 0) return { error: `No session matching "${prefix}".` }
      return { error: `Ambiguous prefix "${prefix}".` }
    }),
    delete: vi.fn(async () => undefined)
  }
}

const getWorkspace = (): string => '/tmp/workspace'

describe('Session commands', () => {
  it('/session_new calls startNewSession and returns confirmation', async () => {
    const startNew = vi.fn(async () => undefined)
    const cmd = sessionNewCommand(startNew)

    const result = await cmd.execute(makeCtx())
    expect(result.content).toContain('New session started')
    expect(startNew).toHaveBeenCalledWith('telegram:42')
  })

  it('/session_list returns workspace session listing', async () => {
    const cmd = sessionListCommand(getWorkspace, mockSessionService(), () => undefined)

    const result = await cmd.execute(makeCtx())
    expect(result.content).toContain('Sessions in /tmp/workspace (1)')
    expect(result.content).toContain('abcdef12')
    expect(result.content).toContain('fix the login bug')
  })

  it('/session_list marks the active session', async () => {
    const cmd = sessionListCommand(getWorkspace, mockSessionService(), () => sampleSession.sessionId)

    const result = await cmd.execute(makeCtx())
    expect(result.content).toContain('`abcdef12` *')
  })

  it('/session_list returns empty message when no sessions', async () => {
    const cmd = sessionListCommand(getWorkspace, mockSessionService([]), () => undefined)
    const result = await cmd.execute(makeCtx())
    expect(result.content).toBe('No sessions found for this workspace.')
  })

  it('/session_select switches session and shows info', async () => {
    const setSession = vi.fn(async () => undefined)
    const cmd = sessionSelectCommand(getWorkspace, mockSessionService(), setSession)

    const result = await cmd.execute(makeCtx({ args: ['abcdef12'], rawArgs: 'abcdef12' }))
    expect(result.content).toContain('Session: abcdef12')
    expect(result.content).toContain('fix the login bug')
    expect(setSession).toHaveBeenCalledWith('telegram:42', sampleSession.sessionId)
  })

  it('/session_select returns error for no match', async () => {
    const cmd = sessionSelectCommand(getWorkspace, mockSessionService(), vi.fn())
    const result = await cmd.execute(makeCtx({ args: ['zzz'], rawArgs: 'zzz' }))
    expect(result.error).toBe(true)
    expect(result.content).toContain('No session matching')
  })

  it('/session_select returns usage error with no args', async () => {
    const cmd = sessionSelectCommand(getWorkspace, mockSessionService(), vi.fn())
    const result = await cmd.execute(makeCtx())
    expect(result.error).toBe(true)
    expect(result.content).toContain('Usage')
  })

  it('/session_delete with no args deletes current session', async () => {
    const clearSession = vi.fn(async () => undefined)
    const service = mockSessionService()
    const cmd = sessionDeleteCommand(getWorkspace, service, () => sampleSession.sessionId, clearSession)

    const result = await cmd.execute(makeCtx())
    expect(result.content).toContain('deleted')
    expect(service.delete).toHaveBeenCalledWith('/tmp/workspace', sampleSession.sessionId)
    expect(clearSession).toHaveBeenCalledWith('telegram:42')
  })

  it('/session_delete with session ID deletes that session', async () => {
    const clearSession = vi.fn(async () => undefined)
    const service = mockSessionService()
    const cmd = sessionDeleteCommand(getWorkspace, service, () => 'other-session-id', clearSession)

    const result = await cmd.execute(makeCtx({ args: ['abcdef12'], rawArgs: 'abcdef12' }))
    expect(result.content).toContain('abcdef12')
    expect(result.content).toContain('deleted')
    expect(service.delete).toHaveBeenCalledWith('/tmp/workspace', sampleSession.sessionId)
    // Should NOT clear binding since deleted session != current session
    expect(clearSession).not.toHaveBeenCalled()
  })

  it('/session_delete returns error when no active session', async () => {
    const cmd = sessionDeleteCommand(getWorkspace, mockSessionService(), () => undefined, vi.fn())
    const result = await cmd.execute(makeCtx())
    expect(result.error).toBe(true)
    expect(result.content).toContain('No active session')
  })
})

describe('Utility commands', () => {
  it('/help lists all registered commands', async () => {
    const registry = new CommandRegistry()
    registry.register(pingCommand())
    registry.register(statusCommand(async () => ({ model: 'm', workspace: '/w', currentWorkspace: '/w', channels: [], sessionInfo: undefined, activeTurns: [] })))
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

  it('/status reports runtime info with session and active turns', async () => {
    const cmd = statusCommand(async () => ({
      model: 'claude-sonnet-4-5',
      workspace: '/tmp/test',
      currentWorkspace: '/tmp/test',
      channels: ['telegram', 'discord'],
      sessionInfo: sampleSession,
      activeTurns: [{ conversationKey: 'telegram:99', prompt: 'write a test' }]
    }))

    const result = await cmd.execute(makeCtx())
    expect(result.content).toContain('claude-sonnet-4-5')
    expect(result.content).toContain('/tmp/test')
    expect(result.content).toContain('telegram, discord')
    // Session info
    expect(result.content).toContain('abcdef12')
    expect(result.content).toContain('fix the login bug')
    expect(result.content).toContain('5 user / 30 assistant')
    // Active turns
    expect(result.content).toContain('Running: 1')
    expect(result.content).toContain('telegram:99')
    expect(result.content).toContain('write a test')
  })

  it('/status shows no-session and no-turns when idle', async () => {
    const cmd = statusCommand(async () => ({
      model: 'claude-sonnet-4-5',
      workspace: '/tmp/test',
      currentWorkspace: '/tmp/test',
      channels: ['telegram'],
      sessionInfo: undefined,
      activeTurns: []
    }))

    const result = await cmd.execute(makeCtx())
    expect(result.content).toContain('No active session.')
    expect(result.content).toContain('No active turns.')
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  reloadCommand,
  restartCommand,
  hotReloadCommand,
  stopCommand
} from '../src/commands/definitions/utility.js'
import type { CommandContext } from '../src/commands/types.js'
import type { PiPipeConfig } from '../src/config/schema.js'

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
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

describe('reloadCommand', () => {
  it('mutates the live config in place with reloaded values', async () => {
    const config = {
      model: 'old-model',
      workspace: '/old',
      personality: { name: 'Old', traits: 'grumpy' }
    } as unknown as PiPipeConfig

    const reloadConfig = (): PiPipeConfig =>
      ({
        model: 'new-model',
        workspace: '/new',
        personality: { name: 'New', traits: 'cheerful' }
      }) as PiPipeConfig

    const cmd = reloadCommand(config, reloadConfig)
    const result = await cmd.execute(makeCtx())

    expect(result.error).toBeFalsy()
    expect(result.content).toContain('new-model')
    expect(result.content).toContain('/new')
    expect(result.content).toContain('New — cheerful')
    expect(config.model).toBe('new-model')
  })

  it('returns plain output when personality is missing', async () => {
    const config = { model: 'old', workspace: '/x' } as unknown as PiPipeConfig
    const reloadConfig = (): PiPipeConfig => ({ model: 'fresh', workspace: '/y' }) as PiPipeConfig

    const result = await reloadCommand(config, reloadConfig).execute(makeCtx())
    expect(result.content).not.toContain('Personality')
  })

  it('returns error when reloadConfig throws', async () => {
    const config = { model: 'old', workspace: '/x' } as unknown as PiPipeConfig
    const reloadConfig = (): PiPipeConfig => {
      throw new Error('broken settings file')
    }

    const result = await reloadCommand(config, reloadConfig).execute(makeCtx())
    expect(result.error).toBe(true)
    expect(result.content).toContain('broken settings file')
  })
})

describe('restartCommand', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a "Restarting..." reply and schedules process.exit', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      void code
      return undefined as never
    }) as never)

    const result = await restartCommand().execute(makeCtx())
    expect(result.content).toContain('Restarting')

    // The scheduled callback only runs when we advance the fake clock
    expect(exitSpy).not.toHaveBeenCalled()
    await vi.advanceTimersToNextTimerAsync()
    expect(exitSpy).toHaveBeenCalledWith(0)
    exitSpy.mockRestore()
  })
})

describe('hotReloadCommand', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns dev-mode message when running under tsx (and skips build)', async () => {
    const original = process.argv[1]
    process.argv[1] = '/usr/local/bin/tsx/dist/cli.mjs'

    const result = await hotReloadCommand('/tmp/proj').execute(makeCtx())
    expect(result.content).toContain('dev mode')

    process.argv[1] = original ?? ''
    // Don't advance the scheduled setImmediate — that path spawns/exits
  })

  it('returns build message in non-dev mode', async () => {
    const original = process.argv[1]
    process.argv[1] = '/usr/local/bin/node'

    const result = await hotReloadCommand('/tmp/proj').execute(makeCtx())
    expect(result.content).toContain('building')

    process.argv[1] = original ?? ''
  })
})

describe('stopCommand', () => {
  it('invokes cancelTurn with the conversation key and confirms', async () => {
    const cancelTurn = vi.fn()
    const result = await stopCommand(cancelTurn).execute(makeCtx())

    expect(cancelTurn).toHaveBeenCalledWith('telegram:42')
    expect(result.content).toBe('Stopped.')
  })
})

import { describe, expect, it, vi } from 'vitest'

import { CommandHandler } from '../src/commands/handler.js'
import { CommandRegistry } from '../src/commands/registry.js'
import type { CommandDefinition } from '../src/commands/types.js'

function makeCommand(overrides?: Partial<CommandDefinition>): CommandDefinition {
  return {
    name: 'test',
    category: 'utility',
    description: 'A test command',
    aliases: [],
    permission: 'user',
    async execute() {
      return { content: 'ok' }
    },
    ...overrides
  }
}

function setup(commands: CommandDefinition[], adminIds: string[] = []) {
  const registry = new CommandRegistry()
  for (const cmd of commands) registry.register(cmd)
  return new CommandHandler(registry, adminIds)
}

describe('CommandHandler', () => {
  it('returns null for non-command messages', async () => {
    const handler = setup([makeCommand({ name: 'ping' })])
    const result = await handler.execute('hello world', 'telegram', '42', 'u1')
    expect(result).toBeNull()
  })

  it('returns null for unrecognised slash commands', async () => {
    const handler = setup([makeCommand({ name: 'ping' })])
    const result = await handler.execute('/unknown', 'telegram', '42', 'u1')
    expect(result).toBeNull()
  })

  it('executes a matched command', async () => {
    const execute = vi.fn(async () => ({ content: 'pong' }))
    const handler = setup([makeCommand({ name: 'ping', execute })])

    const result = await handler.execute('/ping', 'telegram', '42', 'u1')
    expect(result).toEqual({ content: 'pong' })
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'telegram',
        chatId: '42',
        senderId: 'u1',
        conversationKey: 'telegram:42'
      })
    )
  })

  it('matches commands via alias', async () => {
    const execute = vi.fn(async () => ({ content: 'new session' }))
    const handler = setup([makeCommand({ name: 'session_new', aliases: ['new'], execute })])

    const result = await handler.execute('/new', 'telegram', '42', 'u1')
    expect(result).toEqual({ content: 'new session' })
  })

  it('collapses Discord-style two-word commands', async () => {
    const execute = vi.fn(async () => ({ content: 'done' }))
    const handler = setup([makeCommand({ name: 'session_new', execute })])

    const result = await handler.execute('/session new', 'discord', '42', 'u1')
    expect(result).toEqual({ content: 'done' })
  })

  it('parses arguments correctly', async () => {
    let captured: { args: string[]; rawArgs: string } | undefined
    const execute = vi.fn(async (ctx) => {
      captured = { args: ctx.args, rawArgs: ctx.rawArgs }
      return { content: 'ok' }
    })
    const handler = setup([makeCommand({ name: 'ask', execute })])

    await handler.execute('/ask how are you', 'telegram', '42', 'u1')
    expect(captured?.args).toEqual(['how', 'are', 'you'])
    expect(captured?.rawArgs).toBe('how are you')
  })

  it('parses arguments for collapsed two-word commands', async () => {
    let captured: { args: string[]; rawArgs: string } | undefined
    const execute = vi.fn(async (ctx) => {
      captured = { args: ctx.args, rawArgs: ctx.rawArgs }
      return { content: 'ok' }
    })
    const handler = setup([makeCommand({ name: 'config_set', execute })])

    await handler.execute('/config set key value', 'discord', '42', 'u1')
    expect(captured?.args).toEqual(['key', 'value'])
    expect(captured?.rawArgs).toBe('key value')
  })

  it('denies admin commands to non-admin users', async () => {
    const handler = setup(
      [makeCommand({ name: 'secret', permission: 'admin' })],
      ['admin1']
    )

    const result = await handler.execute('/secret', 'telegram', '42', 'regular-user')
    expect(result).toEqual({
      content: 'You do not have permission to use this command.',
      error: true
    })
  })

  it('allows admin commands to admin users', async () => {
    const execute = vi.fn(async () => ({ content: 'granted' }))
    const handler = setup(
      [makeCommand({ name: 'secret', permission: 'admin', execute })],
      ['admin1']
    )

    const result = await handler.execute('/secret', 'telegram', '42', 'admin1')
    expect(result).toEqual({ content: 'granted' })
  })

  it('strips Telegram @bot mention from commands', async () => {
    const execute = vi.fn(async () => ({ content: 'pong' }))
    const handler = setup([makeCommand({ name: 'ping', execute })])

    const result = await handler.execute('/ping@my_bot', 'telegram', '42', 'u1')
    expect(result).toEqual({ content: 'pong' })
  })

  it('isCommand returns true for known commands', () => {
    const handler = setup([makeCommand({ name: 'ping' })])
    expect(handler.isCommand('/ping')).toBe(true)
    expect(handler.isCommand('/unknown')).toBe(false)
    expect(handler.isCommand('hello')).toBe(false)
  })
})

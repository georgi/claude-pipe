import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configSchema } from '../src/config/schema.js'
import { loadConfig } from '../src/config/load.js'
import { isSenderAllowed } from '../src/channels/base.js'
import { TelegramChannel } from '../src/channels/telegram.js'
import { DiscordChannel } from '../src/channels/discord.js'
import { CliChannel } from '../src/channels/cli.js'
import { MessageBus } from '../src/core/bus.js'
import { AgentLoop } from '../src/core/agent-loop.js'
import { setupCommands } from '../src/commands/setup.js'

function config() {
  return configSchema.parse({
    model: 'test',
    workspace: '/tmp',
    sessionStorePath: '/tmp/sessions.json',
    channels: {
      telegram: { enabled: true, token: '', allowFrom: [] },
      discord: { enabled: true, token: '', allowFrom: [], useThreads: false },
      cli: { enabled: true, allowFrom: [] }
    }
  })
}
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('remote ingress authorization', () => {
  it.each(['message', 'voice', 'document', 'callback'])(
    'Telegram rejects %s before side effects',
    async (kind) => {
      const bus = new MessageBus()
      const publish = vi.spyOn(bus, 'publishInbound')
      const fetch = vi.fn()
      vi.stubGlobal('fetch', fetch)
      const adapter = new TelegramChannel(config(), bus, logger) as any
      if (kind === 'callback') {
        await adapter.handleCallbackQuery({ id: 'q', from: { id: 123 }, data: 'run' })
      } else {
        await adapter.handleMessage({
          message: {
            from: { id: 123 },
            chat: { id: 9 },
            text: '/pi_ask run',
            [kind]: { file_id: 'attachment' }
          }
        })
      }
      expect(publish).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'Telegram public access = %s applies to messages and callbacks',
    async (publicAccess) => {
      const cfg = config()
      cfg.channels.telegram.publicAccess = publicAccess
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
      )
      const bus = new MessageBus()
      const publish = vi.spyOn(bus, 'publishInbound')
      const adapter = new TelegramChannel(cfg, bus, logger) as any
      await adapter.handleMessage({
        message: { from: { id: 123 }, chat: { id: 9 }, text: 'hello' }
      })
      await adapter.handleCallbackQuery({ id: 'q', from: { id: 123 }, data: 'run' })
      expect(publish).toHaveBeenCalledTimes(publicAccess ? 2 : 0)
    }
  )

  it.each([false, true])(
    'Discord public access = %s covers guild messages and slash commands',
    async (publicAccess) => {
      const cfg = config()
      cfg.channels.discord.publicAccess = publicAccess
      cfg.channels.discord.allowChannels = ['room']
      const bus = new MessageBus()
      const publish = vi.spyOn(bus, 'publishInbound')
      const adapter = new DiscordChannel(cfg, bus, logger) as any
      adapter.client = { user: { id: 'bot' } }
      const channel = {
        type: 0,
        isTextBased: () => true,
        messages: { fetch: vi.fn(async () => new Map()) }
      }
      await adapter.onMessage({
        author: { id: '123', bot: false },
        channel,
        channelId: 'room',
        content: 'hello',
        mentions: { has: () => true }
      })
      const deferReply = vi.fn()
      await adapter.onInteraction({
        user: { id: '123' },
        channel,
        channelId: 'room',
        commandName: 'help',
        options: { getSubcommand: () => null, getString: () => null },
        reply: vi.fn(),
        deferReply
      })
      expect(publish).toHaveBeenCalledTimes(publicAccess ? 2 : 0)
      expect(deferReply).toHaveBeenCalledTimes(publicAccess ? 1 : 0)
      expect(channel.messages.fetch).not.toHaveBeenCalled()
    }
  )

  it('public Discord still respects channel and DM gates', async () => {
    const cfg = config()
    cfg.channels.discord.publicAccess = true
    cfg.channels.discord.allowChannels = ['room']
    cfg.channels.discord.allowDMs = false
    const bus = new MessageBus()
    const publish = vi.spyOn(bus, 'publishInbound')
    const adapter = new DiscordChannel(cfg, bus, logger) as any
    for (const type of [0, 1]) {
      await adapter.onMessage({
        author: { id: '123', bot: false },
        channel: { type },
        channelId: 'other'
      })
    }
    expect(publish).not.toHaveBeenCalled()
  })

  it('CLI explicit empty list denies local input', async () => {
    const bus = new MessageBus()
    const publish = vi.spyOn(bus, 'publishInbound')
    const adapter = new CliChannel(config(), bus, logger, {
      output: { write: vi.fn() } as any
    }) as any
    await adapter.handleLine('/pi_ask run')
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('execution and admin boundaries', () => {
  it.each(['telegram', 'discord', 'cli'] as const)(
    'rechecks queued %s messages before commands or model calls',
    async (channel) => {
      const cfg = config()
      cfg.channels[channel]!.allowFrom = ['123']
      const bus = new MessageBus()
      const client = { runTurn: vi.fn(), closeAll: vi.fn() }
      const handler = { execute: vi.fn() }
      const loop = new AgentLoop(bus, cfg, client as any, logger)
      loop.setCommandHandler(handler as any)
      await bus.publishInbound({
        channel,
        senderId: '123',
        chatId: 'room',
        content: '/pi_ask run',
        timestamp: ''
      })
      cfg.channels[channel]!.allowFrom = []
      await loop.processOnce()
      expect(handler.execute).not.toHaveBeenCalled()
      expect(client.runTurn).not.toHaveBeenCalled()
    }
  )

  it('admin IDs are channel-scoped, live, and never derived from public access', async () => {
    const cfg = config()
    cfg.channels.telegram.allowFrom = ['123']
    cfg.channels.discord.publicAccess = true
    const { handler } = setupCommands({ config: cfg, pi: {} as any, sessionStore: {} as any })
    expect((await handler.execute('/config_get', 'telegram', 'room', '123'))?.error).not.toBe(true)
    expect((await handler.execute('/config_get', 'discord', 'room', '123'))?.error).toBe(true)
    cfg.channels.telegram.allowFrom = []
    expect((await handler.execute('/config_get', 'telegram', 'room', '123'))?.error).toBe(true)
  })
})

describe('configuration migration', () => {
  it.each([undefined, false, true, 'true'])(
    'loads legacy settings with publicAccess=%s without silently opening access',
    (publicAccess) => {
      const dir = mkdtempSync(join(tmpdir(), 'pipe-access-'))
      vi.stubEnv('CLAUDE_PIPE_CONFIG_DIR', dir)
      try {
        writeFileSync(
          join(dir, 'settings.json'),
          JSON.stringify({
            channel: 'telegram',
            token: 'test',
            allowFrom: [],
            publicAccess,
            model: 'test',
            workspace: '/tmp'
          })
        )
        if (publicAccess === 'true') {
          expect(() => loadConfig()).toThrow()
          return
        }
        const policy = loadConfig().channels.telegram
        expect(isSenderAllowed('123', policy.allowFrom, policy.publicAccess)).toBe(
          publicAccess === true
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it('loads adminFrom from settings for the selected channel only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipe-admin-'))
    vi.stubEnv('CLAUDE_PIPE_CONFIG_DIR', dir)
    try {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({
          channel: 'discord',
          token: 'test',
          allowFrom: ['1', '2'],
          adminFrom: ['1'],
          model: 'test',
          workspace: '/tmp'
        })
      )
      const cfg = loadConfig()
      expect(cfg.channels.discord.adminFrom).toEqual(['1'])
      expect(cfg.channels.telegram.adminFrom).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    [undefined, undefined],
    ['', undefined],
    ['1, 2', ['1', '2']]
  ])('parses CLAUDEPIPE_*_ADMIN_FROM=%s', (value, expected) => {
    const dir = mkdtempSync(join(tmpdir(), 'pipe-env-admin-'))
    vi.stubEnv('CLAUDE_PIPE_CONFIG_DIR', dir)
    if (value !== undefined) {
      vi.stubEnv('CLAUDEPIPE_TELEGRAM_ADMIN_FROM', value)
      vi.stubEnv('CLAUDEPIPE_DISCORD_ADMIN_FROM', value)
      vi.stubEnv('CLAUDEPIPE_CLI_ADMIN_FROM', value)
    }
    try {
      const cfg = loadConfig()
      expect(cfg.channels.telegram.adminFrom).toEqual(expected)
      expect(cfg.channels.discord.adminFrom).toEqual(expected)
      expect(cfg.channels.cli?.adminFrom).toEqual(expected)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['', 'false', '1', 'TRUE', 'true'])(
    'only literal env true enables public access (%s)',
    (value) => {
      const dir = mkdtempSync(join(tmpdir(), 'pipe-env-access-'))
      vi.stubEnv('CLAUDE_PIPE_CONFIG_DIR', dir)
      vi.stubEnv('CLAUDEPIPE_TELEGRAM_PUBLIC_ACCESS', value)
      vi.stubEnv('CLAUDEPIPE_DISCORD_PUBLIC_ACCESS', value)
      try {
        const cfg = loadConfig()
        expect(cfg.channels.telegram.publicAccess).toBe(value === 'true')
        expect(cfg.channels.discord.publicAccess).toBe(value === 'true')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})

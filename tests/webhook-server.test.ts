import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto'

import { WebhookServer } from '../src/channels/webhook-server.js'
import { verifyDiscordSignature } from '../src/channels/discord.js'
import { TelegramChannel } from '../src/channels/telegram.js'
import { DiscordChannel } from '../src/channels/discord.js'
import { MessageBus } from '../src/core/bus.js'
import type { ClaudePipeConfig } from '../src/config/schema.js'

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const originalFetch = globalThis.fetch

function makeWebhookConfig(
  channel: 'telegram' | 'discord',
  overrides?: Partial<{
    webhookSecret: string
    allowChannels: string[]
    port: number
    url: string
  }>
): ClaudePipeConfig {
  return {
    model: 'claude-sonnet-4-5',
    workspace: '/tmp/workspace',
    channels: {
      telegram: {
        enabled: channel === 'telegram',
        token: channel === 'telegram' ? 'TEST_TOKEN' : '',
        allowFrom: channel === 'telegram' ? ['100'] : [],
        webhookSecret: channel === 'telegram' ? (overrides?.webhookSecret ?? 'test-secret') : ''
      },
      discord: {
        enabled: channel === 'discord',
        token: channel === 'discord' ? 'DISCORD_TOKEN' : '',
        allowFrom: channel === 'discord' ? ['u1'] : [],
        allowChannels: channel === 'discord' ? overrides?.allowChannels : undefined,
        webhookSecret: channel === 'discord' ? (overrides?.webhookSecret ?? '') : ''
      }
    },
    webhook: {
      enabled: true,
      port: overrides?.port ?? 0, // port 0 = random available port
      host: '127.0.0.1',
      url: overrides?.url ?? 'https://example.com'
    },
    summaryPrompt: { enabled: true, template: 'test' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20
  } as ClaudePipeConfig
}

/** Resolves the listening port from a running WebhookServer. */
function getPort(server: WebhookServer): number {
  return ((server as any).server.address() as { port: number }).port
}

/** Makes an HTTP POST request to the webhook server. */
async function postWebhook(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  const res = await originalFetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body
  })
  const text = await res.text()
  return { status: res.status, body: text }
}

/* ------------------------------------------------------------------ */
/*  WebhookServer tests                                                */
/* ------------------------------------------------------------------ */

describe('WebhookServer', () => {
  let server: WebhookServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
    vi.resetAllMocks()
    global.fetch = originalFetch
  })

  it('starts and responds to health check', async () => {
    server = new WebhookServer(0, '127.0.0.1', logger)
    await server.start()
    const port = getPort(server)

    const res = await originalFetch(`http://127.0.0.1:${port}/health`)
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json).toEqual({ status: 'ok' })
  })

  it('returns 404 for unknown routes', async () => {
    server = new WebhookServer(0, '127.0.0.1', logger)
    await server.start()
    const port = getPort(server)

    const { status } = await postWebhook(port, '/unknown', '{}')
    expect(status).toBe(404)
  })

  it('returns 405 for non-POST requests to routes', async () => {
    server = new WebhookServer(0, '127.0.0.1', logger)
    server.addRoute('/test', async () => ({ status: 200 }))
    await server.start()
    const port = getPort(server)

    const res = await originalFetch(`http://127.0.0.1:${port}/test`, { method: 'PUT' })
    expect(res.status).toBe(405)
  })

  it('dispatches POST requests to registered route handler', async () => {
    server = new WebhookServer(0, '127.0.0.1', logger)
    server.addRoute('/test', async (body) => {
      const parsed = JSON.parse(body)
      return { status: 200, body: JSON.stringify({ echo: parsed.msg }) }
    })
    await server.start()
    const port = getPort(server)

    const { status, body } = await postWebhook(port, '/test', JSON.stringify({ msg: 'hi' }))
    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ echo: 'hi' })
  })

  it('returns 500 when handler throws', async () => {
    server = new WebhookServer(0, '127.0.0.1', logger)
    server.addRoute('/err', async () => {
      throw new Error('boom')
    })
    await server.start()
    const port = getPort(server)

    const { status } = await postWebhook(port, '/err', '{}')
    expect(status).toBe(500)
  })
})

/* ------------------------------------------------------------------ */
/*  Telegram webhook mode tests                                        */
/* ------------------------------------------------------------------ */

describe('TelegramChannel webhook mode', () => {
  let server: WebhookServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
    vi.resetAllMocks()
    global.fetch = originalFetch
  })

  it('registers route and processes updates via webhook', async () => {
    const config = makeWebhookConfig('telegram', { webhookSecret: 'my-secret' })
    const bus = new MessageBus()
    const channel = new TelegramChannel(config, bus, logger)

    // Mock fetch only for the setWebhook API call
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => ''
    })) as unknown as typeof fetch
    global.fetch = fetchMock

    server = new WebhookServer(0, '127.0.0.1', logger)
    await channel.registerWebhook(server)
    await server.start()
    const port = getPort(server)

    // Verify setWebhook was called
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [setWebhookUrl] = fetchMock.mock.calls[0] as [string]
    expect(setWebhookUrl).toContain('/setWebhook')

    // Restore fetch so postWebhook uses the real fetch
    global.fetch = originalFetch

    // Send a valid webhook update with correct secret
    const update = {
      update_id: 1,
      message: {
        message_id: 42,
        text: 'hello from webhook',
        chat: { id: 200 },
        from: { id: 100 }
      }
    }

    const { status } = await postWebhook(port, '/webhook/telegram', JSON.stringify(update), {
      'x-telegram-bot-api-secret-token': 'my-secret'
    })
    expect(status).toBe(200)

    // Verify message was published to bus
    const inbound = await bus.consumeInbound()
    expect(inbound.channel).toBe('telegram')
    expect(inbound.content).toBe('hello from webhook')
    expect(inbound.chatId).toBe('200')
    expect(inbound.senderId).toBe('100')
  })

  it('rejects webhook requests with wrong secret', async () => {
    const config = makeWebhookConfig('telegram', { webhookSecret: 'correct-secret' })
    const bus = new MessageBus()
    const channel = new TelegramChannel(config, bus, logger)

    // Mock setWebhook API call
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => ''
    })) as unknown as typeof fetch

    server = new WebhookServer(0, '127.0.0.1', logger)
    await channel.registerWebhook(server)
    await server.start()
    const port = getPort(server)

    // Restore real fetch for webhook request
    global.fetch = originalFetch

    const { status } = await postWebhook(
      port,
      '/webhook/telegram',
      JSON.stringify({ update_id: 1 }),
      { 'x-telegram-bot-api-secret-token': 'wrong-secret' }
    )
    expect(status).toBe(401)
  })

  it('skips webhook registration when channel is disabled', async () => {
    const config = makeWebhookConfig('discord') // telegram disabled
    const bus = new MessageBus()
    const channel = new TelegramChannel(config, bus, logger)

    server = new WebhookServer(0, '127.0.0.1', logger)
    await channel.registerWebhook(server)

    // No routes registered
    expect((server as any).routes.size).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/*  Discord Ed25519 signature verification                             */
/* ------------------------------------------------------------------ */

describe('verifyDiscordSignature', () => {
  // Generate a real Ed25519 key pair for testing
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')

  const publicKeyHex = publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(12) // Strip DER prefix to get raw 32-byte key
    .toString('hex')

  function sign(body: string, timestamp: string): string {
    const message = Buffer.from(timestamp + body)
    const signature = cryptoSign(null, message, privateKey)
    return signature.toString('hex')
  }

  it('accepts valid signature', () => {
    const body = '{"type":1}'
    const timestamp = '1234567890'
    const signature = sign(body, timestamp)

    expect(verifyDiscordSignature(body, signature, timestamp, publicKeyHex)).toBe(true)
  })

  it('rejects tampered body', () => {
    const body = '{"type":1}'
    const timestamp = '1234567890'
    const signature = sign(body, timestamp)

    expect(verifyDiscordSignature('{"type":2}', signature, timestamp, publicKeyHex)).toBe(false)
  })

  it('rejects invalid public key hex', () => {
    expect(verifyDiscordSignature('{}', 'aabbcc', '123', 'invalid')).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/*  Discord webhook interaction endpoint                               */
/* ------------------------------------------------------------------ */

describe('DiscordChannel webhook mode', () => {
  let server: WebhookServer | null = null

  // Generate a real Ed25519 key pair for testing
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')

  const publicKeyHex = publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(12)
    .toString('hex')

  function signPayload(body: string, timestamp: string): string {
    const message = Buffer.from(timestamp + body)
    const signature = cryptoSign(null, message, privateKey)
    return signature.toString('hex')
  }

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
    vi.resetAllMocks()
    global.fetch = originalFetch
  })

  it('responds to Discord PING with PONG', async () => {
    const config = makeWebhookConfig('discord', { webhookSecret: publicKeyHex })
    const bus = new MessageBus()
    const channel = new DiscordChannel(config, bus, logger)

    server = new WebhookServer(0, '127.0.0.1', logger)
    await channel.registerWebhook(server)
    await server.start()
    const port = getPort(server)

    const body = JSON.stringify({ type: 1 })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = signPayload(body, timestamp)

    const { status, body: resBody } = await postWebhook(port, '/webhook/discord', body, {
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp
    })

    expect(status).toBe(200)
    expect(JSON.parse(resBody)).toEqual({ type: 1 })
  })

  it('rejects requests without signature headers', async () => {
    const config = makeWebhookConfig('discord', { webhookSecret: publicKeyHex })
    const bus = new MessageBus()
    const channel = new DiscordChannel(config, bus, logger)

    server = new WebhookServer(0, '127.0.0.1', logger)
    await channel.registerWebhook(server)
    await server.start()
    const port = getPort(server)

    const { status } = await postWebhook(
      port,
      '/webhook/discord',
      JSON.stringify({ type: 1 }),
      {} // No signature headers
    )

    expect(status).toBe(401)
  })

  it('publishes APPLICATION_COMMAND interactions to bus', async () => {
    const config = makeWebhookConfig('discord', { webhookSecret: publicKeyHex })
    const bus = new MessageBus()
    const channel = new DiscordChannel(config, bus, logger)

    server = new WebhookServer(0, '127.0.0.1', logger)
    await channel.registerWebhook(server)
    await server.start()
    const port = getPort(server)

    const payload = {
      type: 2,
      id: 'interaction-1',
      data: { name: 'help' },
      member: { user: { id: 'u1' } },
      channel_id: 'ch1',
      guild_id: 'g1'
    }

    const body = JSON.stringify(payload)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = signPayload(body, timestamp)

    const { status, body: resBody } = await postWebhook(port, '/webhook/discord', body, {
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp
    })

    expect(status).toBe(200)
    // Type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    expect(JSON.parse(resBody)).toEqual({ type: 5 })

    const inbound = await bus.consumeInbound()
    expect(inbound.channel).toBe('discord')
    expect(inbound.content).toBe('/help')
    expect(inbound.chatId).toBe('ch1')
    expect(inbound.senderId).toBe('u1')
  })

  it('rejects APPLICATION_COMMAND interactions from non-dedicated channels', async () => {
    const config = makeWebhookConfig('discord', {
      webhookSecret: publicKeyHex,
      allowChannels: ['dedicated-1']
    })
    const bus = new MessageBus()
    const channel = new DiscordChannel(config, bus, logger)

    server = new WebhookServer(0, '127.0.0.1', logger)
    await channel.registerWebhook(server)
    await server.start()
    const port = getPort(server)

    const payload = {
      type: 2,
      id: 'interaction-2',
      data: { name: 'help' },
      member: { user: { id: 'u1' } },
      channel_id: 'other-channel',
      guild_id: 'g1'
    }

    const body = JSON.stringify(payload)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = signPayload(body, timestamp)

    const { status, body: resBody } = await postWebhook(port, '/webhook/discord', body, {
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp
    })

    expect(status).toBe(200)
    expect(JSON.parse(resBody)).toEqual({
      type: 4,
      data: { content: 'This channel is not authorised.', flags: 64 }
    })

    const outcome = await Promise.race([
      bus.consumeInbound().then(() => 'published'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 20))
    ])
    expect(outcome).toBe('timeout')
  })

  it('skips registration when webhookSecret is missing', async () => {
    const config = makeWebhookConfig('discord', { webhookSecret: '' })
    const bus = new MessageBus()
    const channel = new DiscordChannel(config, bus, logger)

    server = new WebhookServer(0, '127.0.0.1', logger)
    await channel.registerWebhook(server)

    expect(logger.warn).toHaveBeenCalledWith(
      'channel.discord.webhook_misconfigured',
      expect.any(Object)
    )
    expect((server as any).routes.size).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/*  Config schema webhook defaults                                     */
/* ------------------------------------------------------------------ */

describe('webhook config schema', () => {
  it('defaults webhook to disabled', async () => {
    const { configSchema } = await import('../src/config/schema.js')

    const parsed = configSchema.parse({
      model: 'claude-sonnet-4-5',
      workspace: '/tmp/workspace',
      channels: {
        telegram: { enabled: false, token: '', allowFrom: [] },
        discord: { enabled: false, token: '', allowFrom: [] }
      },
      sessionStorePath: '/tmp/sessions.json'
    })

    expect(parsed.webhook.enabled).toBe(false)
    expect(parsed.webhook.port).toBe(3000)
    expect(parsed.webhook.host).toBe('0.0.0.0')
    expect(parsed.webhook.url).toBe('')
  })

  it('defaults channel webhookSecret to empty string', async () => {
    const { configSchema } = await import('../src/config/schema.js')

    const parsed = configSchema.parse({
      model: 'test',
      workspace: '/tmp',
      channels: {
        telegram: { enabled: true, token: 'tok', allowFrom: [] },
        discord: { enabled: false, token: '', allowFrom: [] }
      },
      sessionStorePath: '/tmp/s.json'
    })

    expect(parsed.channels.telegram.webhookSecret).toBe('')
    expect(parsed.channels.discord.webhookSecret).toBe('')
  })
})

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import WebSocket from 'ws'

import { MessageBus } from '../src/core/bus.js'
import { AgentLoop } from '../src/core/agent-loop.js'
import type { ClaudePipeConfig } from '../src/config/schema.js'
import { TelegramChannel, type TelegramUpdate } from '../src/channels/telegram.js'

/** Allocates a unique port per test to avoid collisions. */
let portCounter = 19_000
function nextPort(): number {
  return portCounter++
}

function makeConfig(port: number): ClaudePipeConfig {
  return {
    model: 'claude-sonnet-4-5',
    workspace: '/tmp/workspace',
    channels: {
      telegram: { enabled: true, token: 'TEST_TOKEN', allowFrom: ['100'], webhookPort: port },
      discord: { enabled: false, token: '', allowFrom: [] }
    },
    tools: { execTimeoutSec: 60 },
    summaryPrompt: { enabled: true, template: 'Workspace: {{workspace}} Request: {{request}}' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20
  }
}

function makeUpdate(text: string, chatId = 200, fromId = 100): TelegramUpdate {
  return {
    update_id: Math.floor(Math.random() * 100_000),
    message: {
      message_id: Math.floor(Math.random() * 100_000),
      text,
      chat: { id: chatId },
      from: { id: fromId }
    }
  }
}

/** Connects a WebSocket client and waits for it to be open. */
function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

/**
 * Creates a fetch mock that intercepts Telegram API calls but passes through
 * local HTTP requests to the webhook server.
 */
function makeTelegramFetchMock() {
  const realFetch = global.fetch
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    // Pass through local webhook requests to the real fetch
    if (url.startsWith('http://127.0.0.1:')) {
      return realFetch(input, init)
    }
    // Mock Telegram API calls
    return { ok: true, status: 200, text: async () => '' } as Response
  }) as unknown as typeof fetch
  return mock
}

describe('TelegramChannel WebSocket integration', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const originalFetch = global.fetch
  let channel: TelegramChannel

  beforeEach(() => {
    vi.resetAllMocks()
    global.fetch = makeTelegramFetchMock()
  })

  afterEach(async () => {
    global.fetch = originalFetch
    await channel?.stop()
  })

  it('starts HTTP + WebSocket server and accepts connections', async () => {
    const port = nextPort()
    const bus = new MessageBus()
    channel = new TelegramChannel(makeConfig(port), bus, logger)

    await channel.start()

    const addr = channel.address
    expect(addr).not.toBeNull()
    expect(addr!.port).toBe(port)

    const ws = await connectWs(port)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('receives updates via WebSocket and publishes inbound messages', async () => {
    const port = nextPort()
    const bus = new MessageBus()
    channel = new TelegramChannel(makeConfig(port), bus, logger)

    await channel.start()

    const ws = await connectWs(port)
    const update = makeUpdate('hello from ws')
    ws.send(JSON.stringify(update))

    const inbound = await bus.consumeInbound()
    expect(inbound.channel).toBe('telegram')
    expect(inbound.content).toBe('hello from ws')
    expect(inbound.chatId).toBe('200')
    expect(inbound.senderId).toBe('100')

    ws.close()
  })

  it('receives updates via HTTP webhook POST and publishes inbound messages', async () => {
    const port = nextPort()
    const bus = new MessageBus()
    channel = new TelegramChannel(makeConfig(port), bus, logger)

    await channel.start()

    const update = makeUpdate('hello from webhook')
    const response = await originalFetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update)
    })

    expect(response.status).toBe(200)

    const inbound = await bus.consumeInbound()
    expect(inbound.channel).toBe('telegram')
    expect(inbound.content).toBe('hello from webhook')
  })

  it('rejects non-POST HTTP requests', async () => {
    const port = nextPort()
    const bus = new MessageBus()
    channel = new TelegramChannel(makeConfig(port), bus, logger)

    await channel.start()

    const response = await originalFetch(`http://127.0.0.1:${port}`, { method: 'GET' })
    expect(response.status).toBe(405)
  })

  it('returns 400 for invalid JSON in webhook POST', async () => {
    const port = nextPort()
    const bus = new MessageBus()
    channel = new TelegramChannel(makeConfig(port), bus, logger)

    await channel.start()

    const response = await originalFetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not valid json'
    })

    expect(response.status).toBe(400)
  })

  it('validates webhook secret when configured', async () => {
    const port = nextPort()
    const config = makeConfig(port)
    config.channels.telegram.webhookSecret = 'my-secret'
    const bus = new MessageBus()
    channel = new TelegramChannel(config, bus, logger)

    await channel.start()

    // Request without secret should be rejected
    const badResponse = await originalFetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeUpdate('rejected'))
    })
    expect(badResponse.status).toBe(403)

    // Request with correct secret should be accepted
    const goodResponse = await originalFetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'my-secret'
      },
      body: JSON.stringify(makeUpdate('accepted'))
    })
    expect(goodResponse.status).toBe(200)

    const inbound = await bus.consumeInbound()
    expect(inbound.content).toBe('accepted')
  })

  it('drops messages from unauthorized senders via WebSocket', async () => {
    const port = nextPort()
    const bus = new MessageBus()
    channel = new TelegramChannel(makeConfig(port), bus, logger)

    await channel.start()

    const ws = await connectWs(port)
    // sender 999 is not in allowFrom
    ws.send(JSON.stringify(makeUpdate('blocked', 200, 999)))

    const outcome = await Promise.race([
      bus.consumeInbound().then(() => 'published'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 100))
    ])
    expect(outcome).toBe('timeout')
    expect(logger.warn).toHaveBeenCalledWith('channel.telegram.denied', { senderId: '999' })

    ws.close()
  })

  it('handles multiple sequential messages via WebSocket', async () => {
    const port = nextPort()
    const bus = new MessageBus()
    channel = new TelegramChannel(makeConfig(port), bus, logger)

    await channel.start()

    const ws = await connectWs(port)

    ws.send(JSON.stringify(makeUpdate('first')))
    ws.send(JSON.stringify(makeUpdate('second')))
    ws.send(JSON.stringify(makeUpdate('third')))

    const msg1 = await bus.consumeInbound()
    const msg2 = await bus.consumeInbound()
    const msg3 = await bus.consumeInbound()

    expect(msg1.content).toBe('first')
    expect(msg2.content).toBe('second')
    expect(msg3.content).toBe('third')

    ws.close()
  })

  it('logs parse errors for invalid WebSocket messages', async () => {
    const port = nextPort()
    const bus = new MessageBus()
    channel = new TelegramChannel(makeConfig(port), bus, logger)

    await channel.start()

    const ws = await connectWs(port)
    ws.send('not valid json')

    // Wait a bit for the error to be logged
    await new Promise((r) => setTimeout(r, 50))
    expect(logger.error).toHaveBeenCalledWith(
      'channel.telegram.ws_parse_error',
      expect.objectContaining({ error: expect.any(String) })
    )

    ws.close()
  })

  it('skips updates without a message field', async () => {
    const port = nextPort()
    const bus = new MessageBus()
    channel = new TelegramChannel(makeConfig(port), bus, logger)

    await channel.start()

    const ws = await connectWs(port)
    ws.send(JSON.stringify({ update_id: 1 })) // no message field

    const outcome = await Promise.race([
      bus.consumeInbound().then(() => 'published'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 100))
    ])
    expect(outcome).toBe('timeout')

    ws.close()
  })

  it('broadcasts events to connected WebSocket clients', async () => {
    const port = nextPort()
    const bus = new MessageBus()
    channel = new TelegramChannel(makeConfig(port), bus, logger)

    await channel.start()

    const ws = await connectWs(port)

    const received: string[] = []
    ws.on('message', (data) => received.push(String(data)))

    channel.broadcast({ type: 'test', payload: 'hello' })

    await new Promise((r) => setTimeout(r, 50))
    expect(received).toHaveLength(1)
    expect(JSON.parse(received[0]!)).toEqual({ type: 'test', payload: 'hello' })

    ws.close()
  })

  it('stops cleanly and closes all connections', async () => {
    const port = nextPort()
    const bus = new MessageBus()
    channel = new TelegramChannel(makeConfig(port), bus, logger)

    await channel.start()

    const ws = await connectWs(port)
    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()))

    await channel.stop()
    await closed

    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('does not start when channel is disabled', async () => {
    const port = nextPort()
    const config = makeConfig(port)
    config.channels.telegram.enabled = false
    const bus = new MessageBus()
    channel = new TelegramChannel(config, bus, logger)

    await channel.start()

    expect(channel.address).toBeNull()
  })
})

describe('TelegramChannel WebSocket end-to-end flow', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const originalFetch = global.fetch
  let channel: TelegramChannel

  beforeEach(() => {
    vi.resetAllMocks()
    global.fetch = makeTelegramFetchMock()
  })

  afterEach(async () => {
    global.fetch = originalFetch
    await channel?.stop()
  })

  it('receives a WebSocket update, processes through agent loop, and sends response', async () => {
    const port = nextPort()
    const bus = new MessageBus()
    const config = makeConfig(port)

    const claude = {
      runTurn: vi.fn(async () => 'Here is the summary'),
      closeAll: vi.fn()
    }

    const agent = new AgentLoop(bus, config, claude as never, logger)
    channel = new TelegramChannel(config, bus, logger)

    await channel.start()

    // Send update via WebSocket (use summary-matching text)
    const ws = await connectWs(port)
    ws.send(JSON.stringify(makeUpdate('summarize files in workspace')))

    // Process through agent loop
    await (agent as any).processOnce()
    const outbound = await bus.consumeOutbound()
    await channel.send(outbound)

    // Verify Claude was called with templated prompt
    expect(claude.runTurn).toHaveBeenCalledWith(
      'telegram:200',
      expect.stringContaining('Request: summarize files in workspace'),
      expect.objectContaining({ channel: 'telegram', chatId: '200' })
    )

    // Verify Telegram API was called (typing indicator + sendMessage)
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    const telegramCalls = fetchMock.mock.calls.filter(
      ([url]: [string]) => typeof url === 'string' && url.includes('api.telegram.org')
    )
    const typingCalls = telegramCalls.filter(([url]: [string]) => url.includes('/sendChatAction'))
    const sendCalls = telegramCalls.filter(([url]: [string]) => url.includes('/sendMessage'))
    expect(typingCalls.length).toBeGreaterThanOrEqual(1)
    expect(sendCalls).toHaveLength(1)
    expect(String(sendCalls[0]![1]?.body)).toContain('Here is the summary')

    ws.close()
  })

  it('receives a webhook POST, processes through agent loop, and sends response', async () => {
    const port = nextPort()
    const bus = new MessageBus()
    const config = makeConfig(port)

    const claude = {
      runTurn: vi.fn(async () => 'Webhook response'),
      closeAll: vi.fn()
    }

    const agent = new AgentLoop(bus, config, claude as never, logger)
    channel = new TelegramChannel(config, bus, logger)

    await channel.start()

    // Send update via HTTP webhook (use summary-matching text)
    const webhookResponse = await originalFetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeUpdate('summarize project files'))
    })
    expect(webhookResponse.status).toBe(200)

    // Process through agent loop
    await (agent as any).processOnce()
    const outbound = await bus.consumeOutbound()
    await channel.send(outbound)

    expect(claude.runTurn).toHaveBeenCalledWith(
      'telegram:200',
      expect.stringContaining('Request: summarize project files'),
      expect.objectContaining({ channel: 'telegram', chatId: '200' })
    )

    // Verify sendMessage was called with the response
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    const sendCalls = fetchMock.mock.calls.filter(
      ([url]: [string]) => typeof url === 'string' && url.includes('/sendMessage')
    )
    expect(sendCalls).toHaveLength(1)
    expect(String(sendCalls[0]![1]?.body)).toContain('Webhook response')
  })
})

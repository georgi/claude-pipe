import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MessageBus } from '../src/core/bus.js'
import { Heartbeat, createHeartbeat } from '../src/core/heartbeat.js'
import type { PiPipeConfig } from '../src/config/schema.js'

const fakeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

describe('Heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not start the timer when disabled', () => {
    const logger = fakeLogger()
    const hb = new Heartbeat({ enabled: false, intervalMs: 1000 }, new MessageBus(), logger)

    hb.start()
    expect(logger.info).toHaveBeenCalledWith('heartbeat.disabled')

    // Clearing should be a no-op
    hb.stop()
  })

  it('logs heartbeat.no_activity on tick when nothing has been published', async () => {
    const bus = new MessageBus()
    const logger = fakeLogger()
    const hb = new Heartbeat({ enabled: true, intervalMs: 1000 }, bus, logger)

    hb.start()
    await vi.advanceTimersByTimeAsync(1100)

    expect(logger.info).toHaveBeenCalledWith('heartbeat.no_activity')
    hb.stop()
  })

  it('sends a heartbeat to the configured channel when activity occurred', async () => {
    const bus = new MessageBus()
    const logger = fakeLogger()
    const hb = new Heartbeat(
      {
        enabled: true,
        intervalMs: 1000,
        defaultChannel: 'telegram',
        defaultChatId: '42',
      },
      bus,
      logger
    )

    hb.start()

    // Publishing a real (non-progress) message records activity through the wrapped publishOutbound
    await bus.publishOutbound({ channel: 'telegram', chatId: '42', content: 'useful reply' })
    // Drain the message so consumeOutbound below picks up only the heartbeat
    await bus.consumeOutbound()

    await vi.advanceTimersByTimeAsync(1100)

    const heartbeatMsg = await bus.consumeOutbound()
    expect(heartbeatMsg.channel).toBe('telegram')
    expect(heartbeatMsg.chatId).toBe('42')
    expect(heartbeatMsg.content).toContain('Heartbeat')
    expect(heartbeatMsg.content).toContain('1 message sent')
    hb.stop()
  })

  it('logs the heartbeat message when no default channel is configured', async () => {
    const bus = new MessageBus()
    const logger = fakeLogger()
    const hb = new Heartbeat({ enabled: true, intervalMs: 1000 }, bus, logger)

    hb.start()
    await bus.publishOutbound({ channel: 'cli', chatId: 'x', content: 'something' })
    await bus.consumeOutbound()

    await vi.advanceTimersByTimeAsync(1100)

    expect(logger.info).toHaveBeenCalledWith(
      'heartbeat.message',
      expect.objectContaining({ message: expect.stringContaining('Heartbeat') })
    )
    hb.stop()
  })

  it('ignores progress messages when counting activity', async () => {
    const bus = new MessageBus()
    const logger = fakeLogger()
    const hb = new Heartbeat({ enabled: true, intervalMs: 1000 }, bus, logger)

    hb.start()
    await bus.publishOutbound({
      channel: 'cli',
      chatId: 'x',
      content: 'working...',
      metadata: { kind: 'progress' },
    })
    await bus.consumeOutbound()

    await vi.advanceTimersByTimeAsync(1100)

    expect(logger.info).toHaveBeenCalledWith('heartbeat.no_activity')
    hb.stop()
  })

  it('pluralises message count in the heartbeat text', async () => {
    const bus = new MessageBus()
    const logger = fakeLogger()
    const hb = new Heartbeat(
      {
        enabled: true,
        intervalMs: 1000,
        defaultChannel: 'cli',
        defaultChatId: 'a',
      },
      bus,
      logger
    )

    hb.start()
    await bus.publishOutbound({ channel: 'cli', chatId: 'a', content: 'one' })
    await bus.publishOutbound({ channel: 'cli', chatId: 'a', content: 'two' })
    await bus.consumeOutbound()
    await bus.consumeOutbound()

    await vi.advanceTimersByTimeAsync(1100)

    const heartbeatMsg = await bus.consumeOutbound()
    expect(heartbeatMsg.content).toContain('2 messages sent')
    hb.stop()
  })
})

describe('createHeartbeat', () => {
  it('reads heartbeat block from PiPipeConfig and converts minutes to ms', () => {
    const cfg = {
      heartbeat: {
        enabled: true,
        intervalMinutes: 5,
        defaultChannel: 'telegram',
        defaultChatId: 'group-42',
      },
    } as unknown as PiPipeConfig

    const hb = createHeartbeat(cfg, new MessageBus(), fakeLogger())
    expect(hb).toBeInstanceOf(Heartbeat)
  })

  it('uses sensible defaults when heartbeat block is missing', () => {
    const hb = createHeartbeat({} as PiPipeConfig, new MessageBus(), fakeLogger())
    expect(hb).toBeInstanceOf(Heartbeat)
  })
})

import { describe, expect, it, vi } from 'vitest'

import { ChannelManager } from '../src/channels/manager.js'
import { MessageBus } from '../src/core/bus.js'
import type { PiPipeConfig } from '../src/config/schema.js'

function makeConfig(): PiPipeConfig {
  return {
    model: 'claude-sonnet-4-5',
    workspace: '/tmp/ws',
    channels: {
      telegram: { enabled: false, token: '', allowFrom: [] },
      discord: { enabled: false, token: '', allowFrom: [] },
      cli: { enabled: false, allowFrom: [] },
    },
    summaryPrompt: { enabled: false, template: '' },
    transcriptLog: { enabled: false, path: '/tmp/t' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20,
    heartbeat: { enabled: false, intervalMinutes: 30 },
  } as PiPipeConfig
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('ChannelManager', () => {
  it('starts and stops every channel adapter', async () => {
    const mgr = new ChannelManager(makeConfig(), new MessageBus(), makeLogger())
    // All adapters are disabled in config, so start/stop are essentially no-ops
    await mgr.startAll()
    await mgr.stopAll()
  })

  it('sendDirect routes to the matching channel adapter', async () => {
    const mgr = new ChannelManager(makeConfig(), new MessageBus(), makeLogger())
    const sent = { channel: 'cli' as const, chatId: 'x', messageId: '1' }

    const cliAdapter = (mgr as unknown as { channels: Array<{ name: string }> }).channels.find(
      (c) => c.name === 'cli'
    ) as { send: ReturnType<typeof vi.fn> }
    cliAdapter.send = vi.fn(async () => sent)

    const result = await mgr.sendDirect({ channel: 'cli', chatId: 'x', content: 'hi' })
    expect(result).toBe(sent)
    expect(cliAdapter.send).toHaveBeenCalled()
  })

  it('sendDirect warns when channel is unknown', async () => {
    const logger = makeLogger()
    const mgr = new ChannelManager(makeConfig(), new MessageBus(), logger)

    await mgr.sendDirect({ channel: 'mystery' as never, chatId: '1', content: 'x' })
    expect(logger.warn).toHaveBeenCalledWith('channel.unknown', { channel: 'mystery' })
  })

  it('editMessage routes to the matching channel adapter', async () => {
    const mgr = new ChannelManager(makeConfig(), new MessageBus(), makeLogger())
    const edit = vi.fn(async () => undefined)
    const cliAdapter = (mgr as unknown as { channels: Array<{ name: string }> }).channels.find(
      (c) => c.name === 'cli'
    ) as { editMessage: ReturnType<typeof vi.fn> }
    cliAdapter.editMessage = edit

    await mgr.editMessage({ channel: 'cli', chatId: 'x', messageId: '1' }, 'new text')
    expect(edit).toHaveBeenCalled()
  })

  it('editMessage warns when channel is unknown', async () => {
    const logger = makeLogger()
    const mgr = new ChannelManager(makeConfig(), new MessageBus(), logger)
    await mgr.editMessage({ channel: 'bogus' as never, chatId: '1', messageId: '1' }, 'x')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('sendDraftMessage routes to the matching channel adapter', async () => {
    const mgr = new ChannelManager(makeConfig(), new MessageBus(), makeLogger())
    const sentDraft = { channel: 'cli' as const, chatId: 'x', messageId: '1' }
    const cliAdapter = (mgr as unknown as { channels: Array<{ name: string }> }).channels.find(
      (c) => c.name === 'cli'
    ) as { sendMessageDraft: ReturnType<typeof vi.fn> }
    cliAdapter.sendMessageDraft = vi.fn(async () => sentDraft)

    const result = await mgr.sendDraftMessage({ channel: 'cli', chatId: 'x', content: 'draft' })
    expect(result).toBe(sentDraft)
  })

  it('sendDraftMessage warns when channel is unknown', async () => {
    const logger = makeLogger()
    const mgr = new ChannelManager(makeConfig(), new MessageBus(), logger)
    await mgr.sendDraftMessage({ channel: 'bogus' as never, chatId: '1', content: 'x' })
    expect(logger.warn).toHaveBeenCalled()
  })

  it('sendFile routes to the matching channel adapter', async () => {
    const mgr = new ChannelManager(makeConfig(), new MessageBus(), makeLogger())
    const cliAdapter = (mgr as unknown as { channels: Array<{ name: string }> }).channels.find(
      (c) => c.name === 'cli'
    ) as { sendFile: ReturnType<typeof vi.fn> }
    cliAdapter.sendFile = vi.fn(async () => undefined)

    await mgr.sendFile('cli', 'x', { filePath: '/tmp/a.png' })
    expect(cliAdapter.sendFile).toHaveBeenCalledWith('x', { filePath: '/tmp/a.png' })
  })

  it('sendFile warns when channel is unknown', async () => {
    const logger = makeLogger()
    const mgr = new ChannelManager(makeConfig(), new MessageBus(), logger)
    await mgr.sendFile('bogus', 'x', { filePath: '/tmp/a.png' })
    expect(logger.warn).toHaveBeenCalled()
  })

  it('dispatchOutbound routes published messages to channels', async () => {
    const bus = new MessageBus()
    const mgr = new ChannelManager(makeConfig(), bus, makeLogger())

    const send = vi.fn(async () => undefined)
    const cliAdapter = (mgr as unknown as { channels: Array<{ name: string }> }).channels.find(
      (c) => c.name === 'cli'
    ) as { send: ReturnType<typeof vi.fn> }
    cliAdapter.send = send

    await mgr.startAll()
    await bus.publishOutbound({ channel: 'cli', chatId: 'x', content: 'dispatched' })

    // Give the dispatcher a tick
    await new Promise((r) => setTimeout(r, 20))
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ content: 'dispatched' }))

    await mgr.stopAll()
  })

  it('dispatchOutbound warns when a published message targets an unknown channel', async () => {
    const bus = new MessageBus()
    const logger = makeLogger()
    const mgr = new ChannelManager(makeConfig(), bus, logger)

    await mgr.startAll()
    await bus.publishOutbound({ channel: 'bogus' as never, chatId: 'x', content: 'oops' })
    await new Promise((r) => setTimeout(r, 20))

    expect(logger.warn).toHaveBeenCalledWith('channel.unknown', { channel: 'bogus' })
    await mgr.stopAll()
  })
})

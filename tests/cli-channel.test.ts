import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { CliChannel } from '../src/channels/cli.js'
import { MessageBus } from '../src/core/bus.js'

function makeConfig(opts: { enabled?: boolean; allowFrom?: string[] } = {}) {
  const { enabled = true, allowFrom = [] } = opts
  return {
    model: 'claude-sonnet-4-5',
    workspace: '/tmp/workspace',
    channels: {
      telegram: { enabled: false, token: '', allowFrom: [] },
      discord: { enabled: false, token: '', allowFrom: [] },
      cli: { enabled, allowFrom }
    },
    summaryPrompt: { enabled: true, template: 'Workspace: {{workspace}} Request: {{request}}' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20,
    heartbeat: { enabled: false, intervalMinutes: 30 }
  }
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('CliChannel', () => {
  it('publishes inbound message from stdin line', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const bus = new MessageBus()
    const channel = new CliChannel(makeConfig(), bus, makeLogger(), { input, output })

    await channel.start()
    input.write('hello from terminal\n')

    const inbound = await bus.consumeInbound()
    expect(inbound.channel).toBe('cli')
    expect(inbound.chatId).toBe('local-chat')
    expect(inbound.content).toBe('hello from terminal')
  })

  it('prints outbound and progress messages to stdout', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const bus = new MessageBus()
    const channel = new CliChannel(makeConfig(), bus, makeLogger(), { input, output })

    await channel.start()

    await channel.send({ channel: 'cli', chatId: 'local-chat', content: 'done' })
    await channel.send({
      channel: 'cli',
      chatId: 'local-chat',
      content: '',
      metadata: { kind: 'progress', message: 'Using tool: exec' }
    })

    const text = output.read()?.toString() ?? ''
    expect(text).toContain('bot> done')
    expect(text).toContain('progress> Using tool: exec')
  })

  it('skips outbound when CLI channel is disabled', async () => {
    const output = new PassThrough()
    const channel = new CliChannel(makeConfig({ enabled: false }), new MessageBus(), makeLogger(), {
      input: new PassThrough(),
      output
    })

    await channel.start()
    await channel.send({ channel: 'cli', chatId: 'x', content: 'should not appear' })
    expect(output.read()).toBeNull()
  })

  it('ignores messages addressed to other channels', async () => {
    const output = new PassThrough()
    const channel = new CliChannel(makeConfig(), new MessageBus(), makeLogger(), {
      input: new PassThrough(),
      output
    })

    await channel.start()
    await channel.send({ channel: 'telegram', chatId: 'x', content: 'wrong channel' })
    expect((output.read()?.toString() ?? '').includes('wrong channel')).toBe(false)
  })

  it('skips empty-content messages', async () => {
    const output = new PassThrough()
    const channel = new CliChannel(makeConfig(), new MessageBus(), makeLogger(), {
      input: new PassThrough(),
      output
    })
    await channel.start()
    // Drain the start banner
    output.read()

    await channel.send({ channel: 'cli', chatId: 'x', content: '   ' })
    expect(output.read()?.toString() ?? '').toBe('')
  })

  it('editMessage writes an (edit) marker', async () => {
    const output = new PassThrough()
    const channel = new CliChannel(makeConfig(), new MessageBus(), makeLogger(), {
      input: new PassThrough(),
      output
    })

    await channel.start()
    output.read()

    await channel.editMessage({ channel: 'cli', chatId: 'x', messageId: '1' }, 'updated text')
    expect((output.read()?.toString() ?? '')).toContain('bot (edit)> updated text')
  })

  it('sendMessageDraft writes a (draft) marker', async () => {
    const output = new PassThrough()
    const channel = new CliChannel(makeConfig(), new MessageBus(), makeLogger(), {
      input: new PassThrough(),
      output
    })

    await channel.start()
    output.read()

    await channel.sendMessageDraft('x', 'draft text')
    expect((output.read()?.toString() ?? '')).toContain('bot (draft)> draft text')
  })

  it('sendFile writes a (file) marker with caption if provided', async () => {
    const output = new PassThrough()
    const channel = new CliChannel(makeConfig(), new MessageBus(), makeLogger(), {
      input: new PassThrough(),
      output
    })

    await channel.start()
    output.read()

    await channel.sendFile('x', { filePath: '/tmp/a.png', caption: 'a nice image' })
    const text = output.read()?.toString() ?? ''
    expect(text).toContain('bot (file)> /tmp/a.png')
    expect(text).toContain('a nice image')
  })

  it('denies inbound from a sender not in the allowFrom list', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const logger = makeLogger()
    const bus = new MessageBus()

    const channel = new CliChannel(makeConfig({ allowFrom: ['other-user'] }), bus, logger, {
      input,
      output
    })

    await channel.start()
    input.write('forbidden message\n')
    await new Promise((r) => setTimeout(r, 20))

    expect(logger.warn).toHaveBeenCalledWith('channel.cli.denied', expect.any(Object))

    // No inbound should have reached the bus
    const consumeRace = await Promise.race([
      bus.consumeInbound().then(() => 'published'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 30))
    ])
    expect(consumeRace).toBe('timeout')
  })

  it('ignores blank input lines', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const bus = new MessageBus()

    const channel = new CliChannel(makeConfig(), bus, makeLogger(), { input, output })

    await channel.start()
    input.write('   \n')
    await new Promise((r) => setTimeout(r, 20))

    const consumeRace = await Promise.race([
      bus.consumeInbound().then(() => 'published'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 30))
    ])
    expect(consumeRace).toBe('timeout')
  })

  it('stop() closes the readline interface', async () => {
    const channel = new CliChannel(makeConfig(), new MessageBus(), makeLogger(), {
      input: new PassThrough(),
      output: new PassThrough()
    })

    await channel.start()
    await channel.stop()
    // Calling stop again is a no-op
    await channel.stop()
  })

  it('start is a no-op when CLI channel is disabled', async () => {
    const channel = new CliChannel(makeConfig({ enabled: false }), new MessageBus(), makeLogger(), {
      input: new PassThrough(),
      output: new PassThrough()
    })

    await channel.start()
    await channel.stop()
  })
})

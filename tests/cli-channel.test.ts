import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { CliChannel } from '../src/channels/cli.js'
import { MessageBus } from '../src/core/bus.js'

function makeConfig(enabled = true) {
  return {
    model: 'claude-sonnet-4-5',
    workspace: '/tmp/workspace',
    channels: {
      telegram: { enabled: false, token: '', allowFrom: [] },
      discord: { enabled: false, token: '', allowFrom: [] },
      cli: { enabled, allowFrom: [] }
    },
    webhook: { enabled: false, port: 3000, host: '0.0.0.0', url: '' },
    summaryPrompt: { enabled: true, template: 'Workspace: {{workspace}} Request: {{request}}' },
    transcriptLog: { enabled: false, path: '/tmp/transcript.jsonl' },
    sessionStorePath: '/tmp/sessions.json',
    maxToolIterations: 20,
    heartbeat: { enabled: false, intervalMinutes: 30 }
  }
}

describe('CliChannel', () => {
  it('publishes inbound message from stdin line', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const bus = new MessageBus()
    const channel = new CliChannel(
      makeConfig(),
      bus,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { input, output }
    )

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
    const channel = new CliChannel(
      makeConfig(),
      bus,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { input, output }
    )

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
})

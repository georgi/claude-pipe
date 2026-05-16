import { PassThrough } from 'node:stream'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: vi.fn(actual.homedir)
  }
})

const mockedHomedir = homedir as unknown as ReturnType<typeof vi.fn>

describe('runOnboarding', () => {
  let fakeHome: string
  let workspace: string
  let origStdin: NodeJS.ReadableStream
  let origStdout: NodeJS.WritableStream
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'pi-pipe-wizard-home-'))
    workspace = await mkdtemp(join(tmpdir(), 'pi-pipe-wizard-ws-'))
    mockedHomedir.mockReturnValue(fakeHome)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    origStdin = process.stdin
    origStdout = process.stdout
  })

  afterEach(async () => {
    Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true })
    Object.defineProperty(process, 'stdout', { value: origStdout, configurable: true })
    await rm(fakeHome, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function runWithAnswers(
    answers: string[],
    existing?: Parameters<typeof import('../src/onboarding/wizard.js').runOnboarding>[0]
  ): Promise<unknown> {
    const fakeIn = new PassThrough()
    const fakeOut = new PassThrough()
    fakeOut.on('data', () => undefined)

    Object.defineProperty(process, 'stdin', { value: fakeIn, configurable: true })
    Object.defineProperty(process, 'stdout', { value: fakeOut, configurable: true })

    const { runOnboarding } = await import('../src/onboarding/wizard.js')
    const promise = runOnboarding(existing)

    for (const a of answers) {
      await new Promise((r) => setTimeout(r, 5))
      fakeIn.write(`${a}\n`)
    }

    return promise
  }

  it('completes the CLI flow and writes settings.json', async () => {
    await runWithAnswers([
      '3', // CLI channel
      '1', // Claude Haiku 4.5 preset
      workspace, // workspace path
      'TestBot', // personality name
      'witty and short' // personality traits
    ])

    const settingsPath = join(fakeHome, '.pi-pipe', 'settings.json')
    const parsed = JSON.parse(await readFile(settingsPath, 'utf-8'))
    expect(parsed.channel).toBe('cli')
    expect(parsed.model).toBe('claude-haiku-4-5')
    expect(parsed.workspace).toBe(workspace)
    expect(parsed.personality.name).toBe('TestBot')
    expect(parsed.personality.traits).toBe('witty and short')

    // AGENTS.md should have been created in the workspace
    const agentsContent = await readFile(join(workspace, 'AGENTS.md'), 'utf-8')
    expect(agentsContent).toContain('Pi agent')

    // The welcome banner was emitted via console.log
    const banners = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(banners).toContain('Welcome to Pi Pipe')
  })

  it('reconfigure flow keeps existing values when user accepts defaults', async () => {
    const existing = {
      channel: 'cli' as const,
      token: '',
      allowFrom: ['boss'],
      model: 'gpt-5',
      workspace,
      personality: { name: 'OldBot', traits: 'serious' }
    }

    // For gpt-5 (preset '3'), pressing Enter passes '' which falls through to
    // the free-form custom-model prompt — so we need an extra Enter for that.
    // 1 channel + 1 model preset + 1 custom-model fallback + 1 workspace + 2 personality = 6
    const updated = (await runWithAnswers(['', '', '', '', '', ''], existing)) as typeof existing

    expect(updated.channel).toBe('cli')
    expect(updated.model).toBe('gpt-5')
    expect(updated.workspace).toBe(workspace)
    expect(updated.personality?.name).toBe('OldBot')
    expect(updated.allowFrom).toEqual(['boss'])
  })

  it('does not overwrite an existing AGENTS.md in the workspace', async () => {
    // Pre-create AGENTS.md with custom content
    const fsp = await import('node:fs/promises')
    await fsp.writeFile(join(workspace, 'AGENTS.md'), '# Custom\n', 'utf-8')

    await runWithAnswers(['3', '2', workspace, 'Bot', 'serious'])

    const content = await readFile(join(workspace, 'AGENTS.md'), 'utf-8')
    expect(content).toBe('# Custom\n')
  })

  it('reconfigure flow accepts an unknown current model and keeps it via custom prompt', async () => {
    const existing = {
      channel: 'cli' as const,
      token: '',
      allowFrom: [],
      model: 'something-unknown', // getModelChoiceNumber returns '4' → free-form path
      workspace,
      personality: { name: 'X', traits: 'y' }
    }

    // 1 channel + 1 model preset + 1 custom-model name + 1 workspace + 2 personality = 6
    const updated = (await runWithAnswers(['', '', '', '', '', ''], existing)) as typeof existing
    expect(updated.model).toBe('something-unknown')
  })

  it('reports "API key detected" when one is set in the environment', async () => {
    const originalAnthropic = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-fake'

    await runWithAnswers(['3', '1', workspace, 'X', 'snappy'])

    const banners = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(banners).toContain('API key detected')

    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalAnthropic
  })

  it('reconfigure flow keeps the existing telegram token when user presses Enter at the prompt', async () => {
    const existing = {
      channel: 'telegram' as const,
      token: 'existing-token-9876',
      allowFrom: [],
      model: 'claude-sonnet-4-5',
      workspace,
      personality: { name: 'X', traits: 'y' }
    }

    // 1 channel + 1 token + 1 model preset + 1 model custom fallback +
    // 1 workspace + 2 personality = 7 prompts
    const updated = (await runWithAnswers(
      ['', '', '', '', '', '', ''],
      existing
    )) as typeof existing
    expect(updated.token).toBe('existing-token-9876')
  })

  it('hints when no API key is set in the environment', async () => {
    const originalAnthropic = process.env.ANTHROPIC_API_KEY
    const originalOpenai = process.env.OPENAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY

    await runWithAnswers(['3', '1', workspace, 'X', 'snappy'])

    const banners = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(banners).toContain('No ANTHROPIC_API_KEY')

    if (originalAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = originalAnthropic
    if (originalOpenai !== undefined) process.env.OPENAI_API_KEY = originalOpenai
  })

  it('runs the telegram credentials flow and stores the bot token', async () => {
    await runWithAnswers([
      '1', // telegram
      'tg-bot-token-xyz',
      '1', // model preset
      workspace,
      'Pi',
      'brief'
    ])

    const settingsPath = join(fakeHome, '.pi-pipe', 'settings.json')
    const parsed = JSON.parse(await readFile(settingsPath, 'utf-8'))
    expect(parsed.channel).toBe('telegram')
    expect(parsed.token).toBe('tg-bot-token-xyz')
  })

  it('runs the discord credentials flow and stores the bot token', async () => {
    await runWithAnswers([
      '2', // discord
      'dc-bot-token-xyz',
      '1',
      workspace,
      'Pi',
      'brief'
    ])

    const settingsPath = join(fakeHome, '.pi-pipe', 'settings.json')
    const parsed = JSON.parse(await readFile(settingsPath, 'utf-8'))
    expect(parsed.channel).toBe('discord')
    expect(parsed.token).toBe('dc-bot-token-xyz')
  })

  it('accepts a custom free-form model name (option 4)', async () => {
    await runWithAnswers([
      '3', // CLI channel
      '4', // Other (free-form)
      'kimi-k2', // custom model name
      workspace,
      'X',
      'snappy'
    ])

    const settingsPath = join(fakeHome, '.pi-pipe', 'settings.json')
    const parsed = JSON.parse(await readFile(settingsPath, 'utf-8'))
    expect(parsed.model).toBe('kimi-k2')
  })
})

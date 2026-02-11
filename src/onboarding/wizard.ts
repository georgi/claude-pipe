import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { spawn } from 'node:child_process'

import { type Settings, writeSettings } from '../config/settings.js'

/* ------------------------------------------------------------------ */
/*  Readline helpers                                                   */
/* ------------------------------------------------------------------ */

function createInterface(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout })
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()))
  })
}

/* ------------------------------------------------------------------ */
/*  Step 1 – Choose provider + check CLI availability                  */
/* ------------------------------------------------------------------ */

type LlmProvider = 'claude' | 'codex'
type JsonRecord = Record<string, unknown>

interface CodexDiscoveredModel {
  model: string
  displayName: string
  isDefault: boolean
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object'
}

async function fetchCodexModelsFromCli(): Promise<CodexDiscoveredModel[]> {
  const child = spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe']
  })

  let stdoutBuffer = ''
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let nextId = 0

  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = ++nextId
    const payload = { jsonrpc: '2.0', id, method, params }
    child.stdin.write(`${JSON.stringify(payload)}\n`)
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }

  const onError = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }

  child.on('error', onError)
  child.on('close', (code) => {
    if (code !== 0) onError(new Error(`codex app-server exited with code ${String(code)}`))
  })

  child.stdout.on('data', (chunk: Buffer | string) => {
    stdoutBuffer += chunk.toString()
    let newlineIndex = stdoutBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const rawLine = stdoutBuffer.slice(0, newlineIndex).trim()
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      if (rawLine) {
        const parsed = JSON.parse(rawLine) as unknown
        if (isRecord(parsed) && typeof parsed.id === 'number' && 'result' in parsed) {
          const slot = pending.get(parsed.id)
          if (slot) {
            pending.delete(parsed.id)
            slot.resolve(parsed.result)
          }
        } else if (isRecord(parsed) && typeof parsed.id === 'number' && isRecord(parsed.error)) {
          const slot = pending.get(parsed.id)
          if (slot) {
            pending.delete(parsed.id)
            const msg =
              typeof parsed.error.message === 'string'
                ? parsed.error.message
                : 'unknown codex rpc error'
            slot.reject(new Error(msg))
          }
        }
      }
      newlineIndex = stdoutBuffer.indexOf('\n')
    }
  })

  try {
    await request('initialize', {
      clientInfo: { name: 'claude-pipe-setup', title: 'claude-pipe setup', version: '0.1.0' },
      capabilities: { experimentalApi: false }
    })

    const models: CodexDiscoveredModel[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const result = (await request('model/list', { cursor, limit: 100 })) as unknown
      const record = isRecord(result) ? result : {}
      const data = Array.isArray(record.data) ? record.data : []
      for (const entry of data) {
        if (!isRecord(entry)) continue
        const model = typeof entry.model === 'string' ? entry.model : ''
        if (!model) continue
        models.push({
          model,
          displayName: typeof entry.displayName === 'string' ? entry.displayName : model,
          isDefault: entry.isDefault === true
        })
      }
      cursor = typeof record.nextCursor === 'string' ? record.nextCursor : null
      pages += 1
    } while (cursor && pages < 5)

    const dedup = new Map<string, CodexDiscoveredModel>()
    for (const item of models) {
      dedup.set(item.model, item)
    }
    return Array.from(dedup.values())
  } finally {
    child.stdin.end()
    child.kill('SIGTERM')
  }
}

async function chooseProvider(
  rl: readline.Interface,
  current?: LlmProvider
): Promise<LlmProvider> {
  const currentLabel = current === 'claude' ? '1' : current === 'codex' ? '2' : '1'
  console.log('Which LLM runtime do you want to use?\n  1) Claude Code CLI\n  2) OpenAI Codex CLI\n')
  const choice = await ask(rl, `Enter 1 or 2 [${currentLabel}]: `)
  if (choice === '2') return 'codex'
  return 'claude'
}

async function checkSelectedCli(provider: LlmProvider): Promise<void> {
  const { execFileSync } = await import('node:child_process')
  const binary = provider === 'codex' ? 'codex' : 'claude'
  try {
    execFileSync(binary, ['--version'], { stdio: 'pipe' })
  } catch {
    const installUrl =
      provider === 'codex'
        ? 'https://developers.openai.com/codex/cli'
        : 'https://docs.anthropic.com/en/docs/claude-code'
    console.error(
      `\n✖  ${provider === 'codex' ? 'OpenAI Codex CLI' : 'Claude Code CLI'} not found.\n` +
        `   Install it first: ${installUrl}\n`
    )
    process.exit(1)
  }
  console.log(`✔  ${provider === 'codex' ? 'OpenAI Codex CLI' : 'Claude Code CLI'} detected.\n`)
}

/* ------------------------------------------------------------------ */
/*  Step 2 – Choose channel                                            */
/* ------------------------------------------------------------------ */

async function chooseChannel(
  rl: readline.Interface,
  current?: 'telegram' | 'discord' | 'cli'
): Promise<'telegram' | 'discord' | 'cli'> {
  const currentLabel = current === 'telegram' ? '1' : current === 'discord' ? '2' : current === 'cli' ? '3' : ''
  console.log(
    'Which messaging platform do you want to use?\n  1) Telegram\n  2) Discord\n  3) CLI (local terminal)\n'
  )
  const choice = await ask(rl, `Enter 1, 2, or 3${current ? ` [${currentLabel}]` : ''}: `)
  if (choice === '3') return 'cli'
  if (choice === '2') return 'discord'
  if (choice === '1') return 'telegram'
  return current ?? 'telegram'
}

/* ------------------------------------------------------------------ */
/*  Step 3 / 4 – Collect bot credentials                               */
/* ------------------------------------------------------------------ */

async function collectCredentials(
  rl: readline.Interface,
  channel: 'telegram' | 'discord' | 'cli',
  currentToken?: string
): Promise<string> {
  if (channel === 'cli') {
    console.log('\nCLI mode does not require a bot token.\n')
    return ''
  }

  if (channel === 'telegram') {
    console.log(
      '\nCreate a Telegram bot:\n' +
        '  1. Open @BotFather in Telegram\n' +
        '  2. Send /newbot and follow the prompts\n' +
        '  3. Copy the bot token\n'
    )
  } else {
    console.log(
      '\nCreate a Discord bot:\n' +
        '  1. Go to https://discord.com/developers/applications\n' +
        '  2. Create a new application → Bot → Reset Token\n' +
        '  3. Copy the bot token\n'
    )
  }
  let token = ''
  while (!token) {
    const prompt = currentToken
      ? `Paste your bot token [${currentToken.slice(0, 8)}...]: `
      : 'Paste your bot token: '
    const input = await ask(rl, prompt)
    token = input || currentToken || ''
  }
  return token
}

/* ------------------------------------------------------------------ */
/*  Step – Configure optional webhook server                           */
/* ------------------------------------------------------------------ */

interface WebhookSettings {
  enabled: boolean
  port: number
  url: string
  secret: string
}

/* Detect local network IP address */
function detectLocalIp(): string | null {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address
      }
    }
  }
  return null
}

/* Fetch public IP from external service */
async function detectPublicIp(): Promise<string | null> {
  try {
    const response = await fetch('https://api.ipify.org?format=text', {
      signal: AbortSignal.timeout(5000)
    })
    return await response.text()
  } catch {
    return null
  }
}

async function configureWebhook(
  rl: readline.Interface,
  channel: 'telegram' | 'discord' | 'cli',
  currentWebhook?: WebhookSettings
): Promise<WebhookSettings> {
  const disabled: WebhookSettings = { enabled: false, port: 3000, url: '', secret: '' }
  if (channel === 'cli') return disabled

  const currentEnabled = currentWebhook?.enabled
  const defaultChoice = currentEnabled ? '2' : '1'

  console.log(
    '\nWould you like to enable webhook mode?\n\n' +
      '  Webhooks let your bot receive messages via HTTP instead of polling.\n' +
      '  Recommended for production deployments and container environments.\n' +
      '  Requires a publicly accessible URL (or a tunnel like ngrok).\n\n' +
      '  1) No  – use default polling/gateway (simpler, great for development)\n' +
      '  2) Yes – configure a webhook server\n'
  )
  const choice = await ask(rl, `Enter 1 or 2 [${defaultChoice}]: `)
  if (choice === '1') return disabled
  if (choice !== '2' && !currentEnabled) return disabled

  const currentPort = currentWebhook?.port ?? 3000
  const portInput = await ask(rl, `Webhook server port [${currentPort}]: `)
  const port = portInput ? Number(portInput) : currentPort

  // Detect IPs for suggestion
  const localIp = detectLocalIp()
  const publicIp = await detectPublicIp()

  let suggestion = ''
  if (publicIp) {
    suggestion = `\n(detected public IP: http://${publicIp}:${port})`
  } else if (localIp) {
    suggestion = `\n(detected local IP: http://${localIp}:${port})`
  }

  const currentUrl = currentWebhook?.url ?? ''
  if (currentUrl) {
    suggestion += `\n(current: ${currentUrl})`
  }

  let url = ''
  while (!url) {
    const prompt = `Public URL${suggestion}\n(e.g. https://yourdomain.com or https://xxx.ngrok-free.app): `
    url = await ask(rl, prompt)
    if (!url && currentUrl) url = currentUrl
  }

  let secret = ''
  const currentSecret = currentWebhook?.secret ?? ''
  if (channel === 'telegram') {
    console.log(
      '\n  Telegram supports a secret token to verify webhook requests.\n' +
        '  Leave blank to keep current or auto-generate one.\n'
    )
    const prompt = currentSecret
      ? `Webhook secret [${currentSecret}]: `
      : 'Webhook secret [auto]: '
    const input = await ask(rl, prompt)
    secret = input || currentSecret || generateSecret()
    if (input || !currentSecret) console.log(`  ✔  Secret: ${secret}`)
  } else {
    console.log(
      '\n  Discord requires your application\'s public key for webhook verification.\n' +
        '  Find it at: https://discord.com/developers/applications → General Information\n'
    )
    while (!secret) {
      const prompt = currentSecret
        ? `Application public key (hex) [${currentSecret.slice(0, 16)}...]: `
        : 'Application public key (hex): '
      const input = await ask(rl, prompt)
      secret = input || currentSecret || ''
    }
    console.log(
      '\n  After starting the bot, set your Interactions Endpoint URL in the\n' +
        `  Discord Developer Portal to: ${url.replace(/\/$/, '')}/webhook/discord\n`
    )
  }

  return { enabled: true, port, url: url.replace(/\/$/, ''), secret }
}

function generateSecret(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

/* ------------------------------------------------------------------ */
/*  Step 5 – Choose model                                              */
/* ------------------------------------------------------------------ */

const CLAUDE_MODEL_PRESETS: Record<string, string> = {
  '1': 'claude-haiku-4',
  '2': 'claude-sonnet-4-5',
  '3': 'claude-opus-4-5'
}
const CODEX_MODEL_PRESETS: Record<string, string> = {
  '1': 'gpt-5-codex',
  '2': 'gpt-5',
  '3': 'o4-mini'
}

function getModelChoiceNumber(model: string): string {
  if (model === 'claude-haiku-4') return '1'
  if (model === 'claude-sonnet-4-5') return '2'
  if (model === 'claude-opus-4-5') return '3'
  return '4'
}

async function chooseModel(rl: readline.Interface, currentModel?: string): Promise<string> {
  return chooseModelForProvider(rl, 'claude', currentModel)
}

async function chooseModelForProvider(
  rl: readline.Interface,
  provider: LlmProvider,
  currentModel?: string
): Promise<string> {
  if (provider === 'codex') {
    try {
      const discovered = await fetchCodexModelsFromCli()
      if (discovered.length > 0) {
        const sorted = [...discovered].sort((a, b) => {
          if (a.isDefault && !b.isDefault) return -1
          if (!a.isDefault && b.isDefault) return 1
          return a.displayName.localeCompare(b.displayName)
        })
        console.log('\nWhich Codex model would you like to use?')
        const maxShown = Math.min(sorted.length, 12)
        for (let i = 0; i < maxShown; i++) {
          const entry = sorted[i]
          if (!entry) continue
          console.log(
            `  ${i + 1}) ${entry.displayName} (${entry.model})${entry.isDefault ? ' [default]' : ''}`
          )
        }
        const otherIndex = maxShown + 1
        console.log(`  ${otherIndex}) Other (free-form entry)\n`)

        const currentIndex =
          currentModel != null
            ? sorted.findIndex((m) => m.model === currentModel) + 1
            : sorted.findIndex((m) => m.isDefault) + 1
        const fallbackIndex = currentIndex > 0 && currentIndex <= maxShown ? currentIndex : 1
        const choice = await ask(rl, `Enter 1–${otherIndex} [${fallbackIndex}]: `)
        const picked = Number(choice || String(fallbackIndex))
        if (Number.isInteger(picked) && picked >= 1 && picked <= maxShown) {
          const selected = sorted[picked - 1]
          if (selected) return selected.model
        }

        const currentLabel = currentModel ? ` [${currentModel}]` : ''
        const custom = await ask(rl, `Enter model name${currentLabel}: `)
        return custom || currentModel || sorted[0]?.model || 'gpt-5-codex'
      }
    } catch {
      console.log('⚠ Could not fetch live Codex model list. Falling back to local presets.')
    }

    const defaultChoice = currentModel ? getModelChoiceNumberCodex(currentModel) : '1'
    console.log(
      '\nWhich model would you like to use?\n' +
        '  1) GPT-5 Codex\n' +
        '  2) GPT-5\n' +
        '  3) o4-mini\n' +
        '  4) Other (free-form entry)\n'
    )
    const choice = await ask(rl, `Enter 1–4 [${defaultChoice}]: `)
    if (choice in CODEX_MODEL_PRESETS) return CODEX_MODEL_PRESETS[choice]!

    const currentLabel = currentModel ? ` [${currentModel}]` : ''
    const custom = await ask(rl, `Enter model name${currentLabel}: `)
    return custom || currentModel || 'gpt-5-codex'
  }

  const defaultChoice = currentModel ? getModelChoiceNumber(currentModel) : '2'
  console.log(
    '\nWhich model would you like to use?\n' +
      '  1) Haiku\n' +
      '  2) Sonnet 4.5\n' +
      '  3) Opus 4.5\n' +
      '  4) Other (free-form entry)\n'
  )
  const choice = await ask(rl, `Enter 1–4 [${defaultChoice}]: `)
  if (choice in CLAUDE_MODEL_PRESETS) return CLAUDE_MODEL_PRESETS[choice]!

  const currentLabel = currentModel ? ` [${currentModel}]` : ''
  const custom = await ask(rl, `Enter model name (e.g. Minimax, GLM-4.7, Kimi)${currentLabel}: `)
  return custom || currentModel || 'claude-sonnet-4-5'
}

function getModelChoiceNumberCodex(model: string): string {
  if (model === 'gpt-5-codex') return '1'
  if (model === 'gpt-5') return '2'
  if (model === 'o4-mini') return '3'
  return '4'
}

/* ------------------------------------------------------------------ */
/*  Step 6 – Choose workspace + create AGENTS.md                       */
/* ------------------------------------------------------------------ */

const DEFAULT_AGENTS_MD =
  '# AGENTS.md\n\n' +
  'This file configures the Claude agent for this workspace.\n\n' +
  '## Instructions\n\n' +
  '- Answer concisely and accurately.\n' +
  '- When modifying files, explain what changed.\n'

async function chooseWorkspace(rl: readline.Interface, currentWorkspace?: string): Promise<string> {
  const cwd = process.cwd()
  const defaultWorkspace = currentWorkspace || cwd
  const input = await ask(rl, `\nWorkspace path [${defaultWorkspace}]: `)
  const workspace = input || defaultWorkspace

  const resolved = path.resolve(workspace)
  fs.mkdirSync(resolved, { recursive: true })

  const agentsPath = path.join(resolved, 'AGENTS.md')
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, DEFAULT_AGENTS_MD, 'utf-8')
    console.log(`✔  Created ${agentsPath}`)
  } else {
    console.log(`ℹ  ${agentsPath} already exists – skipping.`)
  }

  return resolved
}

/* ------------------------------------------------------------------ */
/*  Main onboarding flow                                               */
/* ------------------------------------------------------------------ */

export async function runOnboarding(existingSettings?: Settings): Promise<Settings> {
  const isReconfigure = !!existingSettings
  console.log(
    isReconfigure
      ? '\n⚙️  Reconfiguring Claude Pipe\n   Press Enter to keep current values.\n'
      : "\n🚀 Welcome to Claude Pipe!\n   Let's get you set up.\n"
  )

  const rl = createInterface()
  try {
    const provider = await chooseProvider(rl, existingSettings?.provider ?? 'claude')
    if (!isReconfigure || existingSettings?.provider !== provider) {
      await checkSelectedCli(provider)
    }
    const channel = await chooseChannel(rl, existingSettings?.channel)
    const token = await collectCredentials(rl, channel, existingSettings?.token)
    const webhook = await configureWebhook(rl, channel, existingSettings?.webhook)
    const model = await chooseModelForProvider(rl, provider, existingSettings?.model)
    const workspace = await chooseWorkspace(rl, existingSettings?.workspace)

    const settings: Settings = {
      provider,
      channel,
      token,
      allowFrom: existingSettings?.allowFrom ?? [],
      model,
      workspace,
      ...(webhook.enabled ? { webhook } : {})
    }

    writeSettings(settings)
    console.log(
      isReconfigure
        ? '\n✔  Settings updated. Run claude-pipe to start the bot.\n'
        : '\n✔  Settings saved. Run claude-pipe again to start the bot.\n'
    )
    return settings
  } finally {
    rl.close()
  }
}

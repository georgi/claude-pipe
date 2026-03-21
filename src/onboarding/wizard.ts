import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'

import { type PersonalitySettings, type Settings, writeSettings } from '../config/settings.js'

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
/*  Step 1 – Check Claude CLI availability                             */
/* ------------------------------------------------------------------ */

async function checkClaudeCli(): Promise<void> {
  const { execFileSync } = await import('node:child_process')
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe' })
  } catch {
    console.error(
      '\n✖  Claude Code CLI not found.\n' +
        '   Install it first: https://docs.anthropic.com/en/docs/claude-code\n'
    )
    process.exit(1)
  }
  console.log('✔  Claude Code CLI detected.\n')
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
/*  Step 5 – Choose model                                              */
/* ------------------------------------------------------------------ */

const CLAUDE_MODEL_PRESETS: Record<string, string> = {
  '1': 'claude-haiku-4-5',
  '2': 'claude-sonnet-4-5',
  '3': 'claude-opus-4-5'
}

function getModelChoiceNumber(model: string): string {
  if (model === 'claude-haiku-4-5') return '1'
  if (model === 'claude-sonnet-4-5') return '2'
  if (model === 'claude-opus-4-5') return '3'
  return '4'
}

async function chooseModel(rl: readline.Interface, currentModel?: string): Promise<string> {
  const defaultChoice = currentModel ? getModelChoiceNumber(currentModel) : '2'
  console.log(
    '\nWhich model would you like to use?\n' +
      '  1) Haiku 4.5\n' +
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
/*  Step 7 – Personality                                               */
/* ------------------------------------------------------------------ */

async function choosePersonality(
  rl: readline.Interface,
  current?: PersonalitySettings
): Promise<PersonalitySettings> {
  console.log(
    '\nGive your assistant a personality!\n' +
      '  Pick a name and describe how it should behave.\n'
  )

  const defaultName = current?.name || 'Piper'
  const name = (await ask(rl, `Assistant name [${defaultName}]: `)) || defaultName

  console.log(
    '\n  Describe its personality in a few words.\n' +
      '  Examples: "friendly and concise", "sarcastic but helpful",\n' +
      '  "formal and professional", "casual and witty"\n'
  )
  const defaultTraits = current?.traits || 'friendly, direct, and concise'
  const traits =
    (await ask(rl, `Personality [${defaultTraits}]: `)) || defaultTraits

  console.log(`\n✔  Your assistant is called ${name} — ${traits}.\n`)
  return { name, traits }
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
    if (!isReconfigure) {
      await checkClaudeCli()
    }
    const channel = await chooseChannel(rl, existingSettings?.channel)
    const token = await collectCredentials(rl, channel, existingSettings?.token)
    const model = await chooseModel(rl, existingSettings?.model)
    const workspace = await chooseWorkspace(rl, existingSettings?.workspace)
    const personality = await choosePersonality(rl, existingSettings?.personality)

    const settings: Settings = {
      channel,
      token,
      allowFrom: existingSettings?.allowFrom ?? [],
      model,
      workspace,
      personality
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

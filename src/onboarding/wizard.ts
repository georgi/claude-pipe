import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'

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
/*  Step 1 – Check Claude Code CLI availability                        */
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

async function chooseChannel(rl: readline.Interface): Promise<'telegram' | 'discord'> {
  console.log('Which messaging platform do you want to use?\n  1) Telegram\n  2) Discord\n')
  const choice = await ask(rl, 'Enter 1 or 2: ')
  if (choice === '2') return 'discord'
  return 'telegram'
}

/* ------------------------------------------------------------------ */
/*  Step 3 / 4 – Collect bot credentials                               */
/* ------------------------------------------------------------------ */

async function collectCredentials(
  rl: readline.Interface,
  channel: 'telegram' | 'discord'
): Promise<string> {
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
    token = await ask(rl, 'Paste your bot token: ')
  }
  return token
}

/* ------------------------------------------------------------------ */
/*  Step 5 – Choose model                                              */
/* ------------------------------------------------------------------ */

const MODEL_PRESETS: Record<string, string> = {
  '1': 'claude-haiku-4',
  '2': 'claude-sonnet-4-5',
  '3': 'claude-opus-4-5'
}

async function chooseModel(rl: readline.Interface): Promise<string> {
  console.log(
    '\nWhich model would you like to use?\n' +
      '  1) Haiku\n' +
      '  2) Sonnet 4.5\n' +
      '  3) Opus 4.5\n' +
      '  4) Other (free-form entry)\n'
  )
  const choice = await ask(rl, 'Enter 1–4: ')
  if (choice in MODEL_PRESETS) return MODEL_PRESETS[choice]!
  const custom = await ask(rl, 'Enter model name (e.g. Minimax, GLM-4.7, Kimi): ')
  return custom || 'claude-sonnet-4-5'
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

async function chooseWorkspace(rl: readline.Interface): Promise<string> {
  const cwd = process.cwd()
  const input = await ask(rl, `\nWorkspace path [${cwd}]: `)
  const workspace = input || cwd

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

export async function runOnboarding(): Promise<Settings> {
  console.log("\n🚀 Welcome to Claude Pipe!\n   Let's get you set up.\n")

  await checkClaudeCli()

  const rl = createInterface()
  try {
    const channel = await chooseChannel(rl)
    const token = await collectCredentials(rl, channel)
    const model = await chooseModel(rl)
    const workspace = await chooseWorkspace(rl)

    const settings: Settings = {
      channel,
      token,
      allowFrom: [],
      model,
      workspace
    }

    writeSettings(settings)
    console.log('\n✔  Settings saved. Run claude-pipe again to start the bot.\n')
    return settings
  } finally {
    rl.close()
  }
}

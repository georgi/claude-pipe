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
/*  Step 1 – Check API key availability                                */
/* ------------------------------------------------------------------ */

function checkApiKey(): void {
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
    console.log('✔  API key detected in environment.\n')
    return
  }
  console.log(
    '⚠  No ANTHROPIC_API_KEY or OPENAI_API_KEY in your environment.\n' +
      '   Pi will need one to talk to a model. Set the variable that matches\n' +
      '   the provider for the model you pick below.\n'
  )
}

/* ------------------------------------------------------------------ */
/*  Step 2 – Choose channel                                            */
/* ------------------------------------------------------------------ */

async function chooseChannel(
  rl: readline.Interface,
  current?: 'telegram' | 'discord' | 'cli'
): Promise<'telegram' | 'discord' | 'cli'> {
  const currentLabel =
    current === 'telegram' ? '1' : current === 'discord' ? '2' : current === 'cli' ? '3' : ''
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
/*  Step 5 – Choose agent harness                                      */
/* ------------------------------------------------------------------ */

async function chooseHarness(
  rl: readline.Interface,
  current?: 'pi' | 'claude'
): Promise<'pi' | 'claude'> {
  const defaultChoice = current === 'claude' ? '2' : '1'
  console.log(
    '\nWhich agent harness should drive your assistant?\n' +
      '  1) Pi Coding Agent SDK   (multi-provider: Claude, GPT, Gemini, …)\n' +
      '  2) Claude Agent SDK      (Anthropic models only; needs ANTHROPIC_API_KEY)\n'
  )
  const choice = await ask(rl, `Enter 1 or 2 [${defaultChoice}]: `)
  const effective = choice || defaultChoice
  return effective === '2' ? 'claude' : 'pi'
}

/* ------------------------------------------------------------------ */
/*  Step 6 – Choose model                                              */
/* ------------------------------------------------------------------ */

const PI_MODEL_PRESETS: Record<string, string> = {
  '1': 'claude-haiku-4-5',
  '2': 'claude-sonnet-4-5',
  '3': 'gpt-5'
}

// The Claude harness passes the model straight into the Claude Agent SDK, which
// only accepts Anthropic models — so its preset list omits non-Anthropic
// options and the free-form prompt is scoped to Anthropic model ids.
const CLAUDE_MODEL_PRESETS: Record<string, string> = {
  '1': 'claude-haiku-4-5',
  '2': 'claude-sonnet-4-5'
}

function getModelChoiceNumber(model: string, harness: 'pi' | 'claude'): string {
  if (model === 'claude-haiku-4-5') return '1'
  if (model === 'claude-sonnet-4-5') return '2'
  if (harness === 'claude') return '3'
  if (model === 'gpt-5') return '3'
  return '4'
}

async function chooseModel(
  rl: readline.Interface,
  harness: 'pi' | 'claude',
  currentModel?: string
): Promise<string> {
  const defaultChoice = currentModel ? getModelChoiceNumber(currentModel, harness) : '2'

  if (harness === 'claude') {
    console.log(
      '\nWhich Claude model would you like to use? (the Claude harness is Anthropic-only)\n' +
        '  1) Claude Haiku 4.5  (needs ANTHROPIC_API_KEY)\n' +
        '  2) Claude Sonnet 4.5 (needs ANTHROPIC_API_KEY)\n' +
        '  3) Other (free-form Anthropic model id, e.g. claude-opus-4-1)\n'
    )
    const choice = await ask(rl, `Enter 1–3 [${defaultChoice}]: `)
    const effectiveChoice = choice || defaultChoice
    if (effectiveChoice in CLAUDE_MODEL_PRESETS) return CLAUDE_MODEL_PRESETS[effectiveChoice]!

    const currentLabel = currentModel ? ` [${currentModel}]` : ''
    const custom = await ask(rl, `Enter Anthropic model id (e.g. claude-opus-4-1)${currentLabel}: `)
    return custom || currentModel || 'claude-sonnet-4-5'
  }

  console.log(
    '\nWhich model would you like to use?\n' +
      '  1) Claude Haiku 4.5  (needs ANTHROPIC_API_KEY)\n' +
      '  2) Claude Sonnet 4.5 (needs ANTHROPIC_API_KEY)\n' +
      '  3) GPT-5             (needs OPENAI_API_KEY)\n' +
      '  4) Other (free-form entry — supports provider/model-id syntax)\n'
  )
  const choice = await ask(rl, `Enter 1–4 [${defaultChoice}]: `)
  // An empty answer means "accept the displayed default" — only fall through
  // to the free-form prompt when the user explicitly picks "4".
  const effectiveChoice = choice || defaultChoice
  if (effectiveChoice in PI_MODEL_PRESETS) return PI_MODEL_PRESETS[effectiveChoice]!

  const currentLabel = currentModel ? ` [${currentModel}]` : ''
  const custom = await ask(
    rl,
    `Enter model name (e.g. kimi-k2, glm-4.6, gemini-2.5-pro)${currentLabel}: `
  )
  return custom || currentModel || 'claude-sonnet-4-5'
}

/* ------------------------------------------------------------------ */
/*  Step 6 – Choose workspace + create AGENTS.md                       */
/* ------------------------------------------------------------------ */

const DEFAULT_AGENTS_MD =
  '# AGENTS.md\n\n' +
  'This file configures the Pi agent for this workspace.\n\n' +
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
    '\nGive your assistant a personality!\n' + '  Pick a name and describe how it should behave.\n'
  )

  const defaultName = current?.name || 'Piper'
  const name = (await ask(rl, `Assistant name [${defaultName}]: `)) || defaultName

  console.log(
    '\n  Describe its personality in a few words.\n' +
      '  Examples: "friendly and concise", "sarcastic but helpful",\n' +
      '  "formal and professional", "casual and witty"\n'
  )
  const defaultTraits = current?.traits || 'friendly, direct, and concise'
  const traits = (await ask(rl, `Personality [${defaultTraits}]: `)) || defaultTraits

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
      ? '\n⚙️  Reconfiguring Pi Pipe\n   Press Enter to keep current values.\n'
      : "\n🚀 Welcome to Pi Pipe!\n   Let's get you set up.\n"
  )

  const rl = createInterface()
  try {
    if (!isReconfigure) {
      checkApiKey()
    }
    const channel = await chooseChannel(rl, existingSettings?.channel)
    const token = await collectCredentials(rl, channel, existingSettings?.token)
    const harness = await chooseHarness(rl, existingSettings?.harness)
    const model = await chooseModel(rl, harness, existingSettings?.model)
    const workspace = await chooseWorkspace(rl, existingSettings?.workspace)
    const personality = await choosePersonality(rl, existingSettings?.personality)

    const settings: Settings = {
      channel,
      token,
      allowFrom: existingSettings?.allowFrom ?? [],
      harness,
      model,
      workspace,
      personality
    }

    writeSettings(settings)
    console.log(
      isReconfigure
        ? '\n✔  Settings updated. Run `npm run dev` (or `npm start` after `npm run build`) to start the bot.\n'
        : '\n✔  Settings saved. Run `npm run dev` (or `npm start` after `npm run build`) to start the bot.\n'
    )
    return settings
  } finally {
    rl.close()
  }
}

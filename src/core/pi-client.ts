import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI
} from '@earendil-works/pi-coding-agent'
import { getModel } from '@earendil-works/pi-ai'
import type { Model } from '@earendil-works/pi-ai'

import type { PiPipeConfig } from '../config/schema.js'
import { getConfigDir } from '../config/settings.js'
import type { ModelClient } from './model-client.js'
import { SessionStore } from './session-store.js'
import { buildSystemPrompt } from './system-prompt.js'
import { TranscriptLogger } from './transcript-logger.js'
import { Guardrail } from './guardrail.js'
import { createGuardrailExtension } from './guardrail-extension.js'
import type { AgentTurnUpdate, Logger, ToolContext } from './types.js'

/**
 * A Pi extension that contributes pi-pipe's instructions to the agent via the
 * `before_agent_start` hook. The factory closes over a getter so config edits
 * (e.g. `/pi_model` switching the active model) are picked up without
 * re-creating the session.
 */
export function createInstructionsExtension(getPrompt: () => string) {
  return (pi: ExtensionAPI): void => {
    pi.on('before_agent_start', (event) => {
      const extra = getPrompt()
      if (!extra) return undefined
      const chained = event.systemPrompt ?? ''
      return { systemPrompt: chained ? `${chained}\n\n${extra}` : extra }
    })
  }
}

const PROVIDER_PREFIXES: Array<[RegExp, string]> = [
  [/^claude/i, 'anthropic'],
  [/^gpt|^o[0-9]/i, 'openai'],
  [/^gemini/i, 'google'],
  [/^kimi|^moonshot/i, 'moonshotai'],
  [/^deepseek/i, 'deepseek'],
  [/^llama|^groq/i, 'groq'],
  [/^mistral|^codestral/i, 'mistral'],
  [/^grok|^xai/i, 'xai'],
  [/^qwen/i, 'alibaba'],
  [/^minimax/i, 'minimax'],
  [/^glm|^zai/i, 'zai']
]

/**
 * Resolves a model string (e.g. "claude-sonnet-4-5", "openai/gpt-5") to a
 * Pi `Model` object. Supports explicit `provider/id` syntax or prefix
 * inference. Falls back to scanning the ModelRegistry by id.
 */
export function resolveModel(modelString: string, registry: ModelRegistry): Model<never> {
  if (modelString.includes('/')) {
    const [provider, ...rest] = modelString.split('/')
    const id = rest.join('/')
    const m = registry.find(provider!, id)
    if (m) return m as Model<never>
    const builtin = tryGetModel(provider!, id)
    if (builtin) return builtin
  }
  for (const [pattern, provider] of PROVIDER_PREFIXES) {
    if (pattern.test(modelString)) {
      const m = registry.find(provider, modelString) ?? tryGetModel(provider, modelString)
      if (m) return m as Model<never>
    }
  }
  for (const m of registry.getAll()) {
    if (m.id === modelString) return m as Model<never>
  }
  throw new Error(
    `Unknown model "${modelString}". Use a known id (e.g. claude-sonnet-4-5) or provider/id syntax.`
  )
}

function tryGetModel(provider: string, id: string): Model<never> | undefined {
  try {
    return getModel(provider as never, id as never) as Model<never>
  } catch {
    return undefined
  }
}

function extractErrorText(result: unknown): string {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    const r = result as { content?: unknown; error?: unknown; message?: unknown }
    if (typeof r.error === 'string') return r.error
    if (typeof r.message === 'string') return r.message
    if (Array.isArray(r.content)) {
      const parts = r.content
        .map((c) =>
          c && typeof c === 'object' && 'text' in c ? (c as { text?: string }).text : ''
        )
        .filter(Boolean)
      if (parts.length > 0) return parts.join(' ')
    }
  }
  return ''
}

/**
 * Runs Pi via the official Pi Coding Agent SDK.
 *
 * Each conversation key owns a long-lived `AgentSession` cached in memory.
 * On first turn the session file is persisted so cross-restart resumption
 * uses `SessionManager.open(filePath)`.
 *
 * The pi-pipe system prompt (communication style + attachment / keyboard /
 * memory marker protocol) is contributed by a Pi extension that hooks
 * `before_agent_start` — no SDK internals are mutated.
 *
 * Cancellation invokes `session.abort()`, which causes the in-flight
 * `prompt()` to reject.
 */
export class PiClient implements ModelClient {
  private readonly transcript: TranscriptLogger
  private readonly sessions = new Map<string, AgentSession>()
  /** Model string used when each cached session was last reconciled. */
  private readonly sessionModels = new Map<string, string>()
  private readonly eventChain = new Map<string, Promise<void>>()
  private readonly modelRegistry: ModelRegistry
  private readonly agentDir: string
  private readonly guardrail = new Guardrail({ extraSensitivePaths: [getConfigDir()] })

  constructor(
    private config: PiPipeConfig,
    private readonly store: SessionStore,
    private readonly logger: Logger
  ) {
    this.transcript = new TranscriptLogger({
      enabled: this.config.transcriptLog.enabled,
      path: this.config.transcriptLog.path,
      ...(this.config.transcriptLog.maxBytes != null
        ? { maxBytes: this.config.transcriptLog.maxBytes }
        : {}),
      ...(this.config.transcriptLog.maxFiles != null
        ? { maxFiles: this.config.transcriptLog.maxFiles }
        : {})
    })
    this.agentDir = getAgentDir()
    const authStorage = AuthStorage.create()
    this.modelRegistry = ModelRegistry.create(authStorage)
  }

  private async makeResourceLoader(): Promise<DefaultResourceLoader> {
    // Let Pi's natural discovery load the workspace AGENTS.md, user-installed
    // extensions from ~/.pi/agent/extensions/, and skills from
    // ~/.pi/agent/skills/. Our instructions extension is appended via
    // `extensionFactories` and runs alongside whatever the user has configured.
    const extensionFactories = [createInstructionsExtension(() => buildSystemPrompt(this.config))]
    // The guardrail (blocks bash/edit/write + sensitive reads) only applies in
    // sandbox mode; a normal deployment keeps Pi's full default tool set.
    if (this.config.sandbox) {
      extensionFactories.push(createGuardrailExtension(this.guardrail))
    }
    const loader = new DefaultResourceLoader({
      cwd: this.config.workspace,
      agentDir: this.agentDir,
      extensionFactories
    })
    await loader.reload()
    return loader
  }

  private async getOrCreateSession(conversationKey: string): Promise<AgentSession> {
    const cached = this.sessions.get(conversationKey)
    if (cached) {
      // The shared config may have been reloaded with a new model since this
      // session was created (e.g. via `/reload`). Reconcile the session's
      // model with the live config before using it so cached conversations
      // don't keep hitting the old model after a config edit.
      if (this.sessionModels.get(conversationKey) !== this.config.model) {
        try {
          const resolved = resolveModel(this.config.model, this.modelRegistry)
          await cached.setModel(resolved)
          this.sessionModels.set(conversationKey, this.config.model)
        } catch (err) {
          this.logger.warn('pi.session_model_reconcile_failed', {
            conversationKey,
            model: this.config.model,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
      return cached
    }

    const saved = this.store.get(conversationKey)
    const model = resolveModel(this.config.model, this.modelRegistry)
    const resourceLoader = await this.makeResourceLoader()

    const sessionManager = saved?.sessionFile
      ? SessionManager.open(saved.sessionFile)
      : SessionManager.create(this.config.workspace)

    const { session } = await createAgentSession({
      cwd: this.config.workspace,
      agentDir: this.agentDir,
      model,
      modelRegistry: this.modelRegistry,
      resourceLoader,
      sessionManager
    })

    if (!saved?.sessionFile && session.sessionFile) {
      await this.store.set(conversationKey, { sessionFile: session.sessionFile })
    }

    this.sessions.set(conversationKey, session)
    this.sessionModels.set(conversationKey, this.config.model)
    return session
  }

  private async publishUpdate(context: ToolContext, event: AgentTurnUpdate): Promise<void> {
    if (!context.onUpdate) return
    await context.onUpdate(event)
  }

  /** Serializes per-conversation onUpdate calls so emitted events stay ordered. */
  private schedule(conversationKey: string, task: () => Promise<void>): void {
    const prev = this.eventChain.get(conversationKey) ?? Promise.resolve()
    const next = prev.then(task, task)
    this.eventChain.set(conversationKey, next)
  }

  private async drain(conversationKey: string): Promise<void> {
    await this.eventChain.get(conversationKey)
  }

  async runTurn(conversationKey: string, userText: string, context: ToolContext): Promise<string> {
    const session = await this.getOrCreateSession(conversationKey)

    let responseText = ''
    let lastErrorText = ''

    const handler = (event: AgentSessionEvent): void => {
      if (event.type === 'message_update') {
        const am = event.assistantMessageEvent
        if (am.type === 'text_delta') {
          responseText += am.delta
          this.schedule(conversationKey, async () => {
            await this.publishUpdate(context, {
              kind: 'text_streaming',
              conversationKey,
              message: 'Streaming response...',
              text: responseText
            })
          })
        }
        return
      }
      if (event.type === 'tool_execution_start') {
        const toolName = event.toolName
        const toolUseId = event.toolCallId
        this.logger.info('pi.tool_call_started', { conversationKey, toolName, toolUseId })
        this.schedule(conversationKey, async () => {
          await this.publishUpdate(context, {
            kind: 'tool_call_started',
            conversationKey,
            message: `Using tool: ${toolName}`,
            toolName,
            toolUseId
          })
        })
        return
      }
      if (event.type === 'tool_execution_end') {
        const toolName = event.toolName
        const toolUseId = event.toolCallId
        const failed = event.isError === true
        if (failed) {
          lastErrorText = extractErrorText(event.result) || lastErrorText
          this.logger.warn('pi.tool_call_failed', { conversationKey, toolName, toolUseId })
        } else {
          this.logger.info('pi.tool_call_finished', { conversationKey, toolName, toolUseId })
        }
        this.schedule(conversationKey, async () => {
          await this.publishUpdate(context, {
            kind: failed ? 'tool_call_failed' : 'tool_call_finished',
            conversationKey,
            message: failed ? `Tool failed: ${toolName}` : `Tool completed: ${toolName}`,
            toolName,
            toolUseId
          })
        })
        return
      }
    }

    const unsubscribe = session.subscribe(handler)
    this.schedule(conversationKey, async () => {
      await this.publishUpdate(context, {
        kind: 'turn_started',
        conversationKey,
        message: 'Working on it...'
      })
    })
    await this.transcript.log(conversationKey, { type: 'user', text: userText })

    let aborted = false
    try {
      await session.prompt(userText)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/abort/i.test(msg)) {
        aborted = true
      } else {
        lastErrorText = msg
        this.logger.error('pi.turn_failed', { conversationKey, error: msg })
      }
    } finally {
      unsubscribe()
    }

    await this.drain(conversationKey)
    this.schedule(conversationKey, async () => {
      await this.publishUpdate(context, {
        kind: 'turn_finished',
        conversationKey,
        message: aborted ? 'Turn cancelled' : 'Turn finished'
      })
    })
    await this.drain(conversationKey)

    if (responseText) {
      await this.transcript.log(conversationKey, { type: 'assistant_text', text: responseText })
      this.logger.info('pi.turn_finished', { conversationKey })
      return responseText
    }
    if (aborted) return 'Cancelled.'
    if (lastErrorText) return `Sorry, I hit an error: ${lastErrorText.slice(0, 200)}`
    return 'I completed processing but have no response to return.'
  }

  cancelTurn(conversationKey: string): void {
    const session = this.sessions.get(conversationKey)
    if (session) void session.abort()
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      void session.abort()
    }
    this.sessions.clear()
    this.sessionModels.clear()
    this.eventChain.clear()
  }

  async startNewSession(conversationKey: string): Promise<void> {
    const cached = this.sessions.get(conversationKey)
    if (cached) {
      // Abort any in-flight prompt so it can't keep streaming or holding
      // resources after the session is replaced.
      try {
        await cached.abort()
      } catch {
        /* abort may reject if no prompt is in flight — ignore */
      }
    }
    this.sessions.delete(conversationKey)
    this.sessionModels.delete(conversationKey)
    this.eventChain.delete(conversationKey)
    await this.store.clear(conversationKey)
  }

  /**
   * Used by the `/pi_model` command to swap the model on every cached session.
   *
   * Resolves the model first and only mutates the shared config (so `/status`
   * and `/pi_model` keep observing it) after resolution succeeds, so an
   * unknown model name leaves the runtime in a consistent state.
   */
  setModel(modelString: string): void {
    const resolved = resolveModel(modelString, this.modelRegistry)
    this.config.model = modelString
    for (const [conversationKey, session] of this.sessions) {
      void session.setModel(resolved)
      this.sessionModels.set(conversationKey, modelString)
    }
  }
}

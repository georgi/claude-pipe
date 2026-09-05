import { Codex, type Thread, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk'

import type { PiPipeConfig } from '../config/schema.js'
import type { ModelClient } from './model-client.js'
import { SessionStore } from './session-store.js'
import { buildSystemPrompt } from './system-prompt.js'
import { TranscriptLogger } from './transcript-logger.js'
import { condense, shortPath, summarizeToolInput } from './tool-format.js'
import type { AgentTurnUpdate, Logger, ToolContext } from './types.js'

/**
 * Maps a Codex thread item onto the `{ toolName, toolDetail }` pair the chat
 * channels render as a status line.
 *
 * Codex reports activity as typed items rather than as generic tool calls, so
 * each item type is given the tool name its Claude/Pi equivalent would use
 * (`Bash` for a shell command, `Edit` for a patch, …). That keeps status lines
 * identical across harnesses even though the underlying SDKs differ.
 *
 * Returns `undefined` for items that aren't tool activity (assistant messages,
 * reasoning, errors) so callers can skip them.
 */
export function describeItem(
  item: ThreadItem
): { toolName: string; toolDetail: string } | undefined {
  switch (item.type) {
    case 'command_execution':
      return { toolName: 'Bash', toolDetail: condense(item.command) }
    case 'file_change': {
      const changes = item.changes ?? []
      if (changes.length === 1) {
        const only = changes[0]!
        return { toolName: 'Edit', toolDetail: condense(`${only.kind} ${shortPath(only.path)}`) }
      }
      return {
        toolName: 'Edit',
        toolDetail: `${changes.length} file${changes.length === 1 ? '' : 's'}`
      }
    }
    case 'mcp_tool_call':
      return {
        toolName: `mcp__${item.server}__${item.tool}`,
        toolDetail: summarizeToolInput(item.tool, item.arguments)
      }
    case 'web_search':
      return { toolName: 'WebSearch', toolDetail: condense(item.query) }
    case 'todo_list': {
      const items = item.items ?? []
      const active = items.find((todo) => !todo.completed)
      return {
        toolName: 'TodoWrite',
        toolDetail: active
          ? condense(active.text, 80)
          : `${items.length} task${items.length === 1 ? '' : 's'}`
      }
    }
    default:
      return undefined
  }
}

/** True when a terminal item reports failure rather than success. */
function itemFailed(item: ThreadItem): boolean {
  if (item.type === 'command_execution') return item.status === 'failed'
  if (item.type === 'file_change') return item.status === 'failed'
  if (item.type === 'mcp_tool_call') return item.status === 'failed'
  return false
}

/**
 * Runs OpenAI Codex via the official Codex SDK, one `runStreamed()` call per
 * turn.
 *
 * This is the Codex counterpart to {@link ClaudeClient} and {@link PiClient}:
 * all three satisfy the same {@link ModelClient} contract, share the system
 * prompt from `./system-prompt.js`, and translate their SDK's stream into the
 * agent loop's {@link AgentTurnUpdate} events, so the surrounding app can't
 * tell which harness is active.
 *
 * Two things differ from the other harnesses and shape the implementation:
 *
 * - **No system-prompt hook.** The Codex SDK exposes no way to append
 *   instructions to the agent's system prompt, so the pi-pipe prompt is
 *   prepended to the first user message of each thread. Codex keeps the whole
 *   thread transcript, so later turns (and turns after a restart, which resume
 *   the same thread) inherit it without paying for it again.
 * - **Threads are cheap handles.** Each turn spawns a fresh `codex exec`
 *   process that resumes the persisted thread, so a {@link Thread} is just an
 *   id plus options. Recreating one to change the model costs nothing.
 *
 * Sessions resume across turns via the thread id from the `thread.started`
 * event, persisted as a {@link SessionRef} `{ sessionId }`. Cancellation uses
 * an `AbortController` whose signal is handed to `runStreamed()`.
 */
export class CodexClient implements ModelClient {
  private readonly transcript: TranscriptLogger
  private readonly codex: Codex
  private readonly threads = new Map<string, Thread>()
  /** Model string each cached thread was created with, for reconciliation. */
  private readonly threadModels = new Map<string, string>()
  private readonly abortControllers = new Map<string, AbortController>()

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
    this.codex = new Codex()
  }

  /** Thread options derived from the live config, re-read on every creation. */
  private threadOptions(): Parameters<Codex['startThread']>[0] {
    const codexConfig = this.config.codex
    return {
      model: this.config.model,
      workingDirectory: this.config.workspace,
      skipGitRepoCheck: codexConfig.skipGitRepoCheck,
      sandboxMode: codexConfig.sandboxMode,
      approvalPolicy: codexConfig.approvalPolicy,
      webSearchEnabled: codexConfig.webSearch,
      ...(codexConfig.reasoningEffort ? { modelReasoningEffort: codexConfig.reasoningEffort } : {})
    }
  }

  /**
   * Returns the thread for a conversation, resuming the persisted one when
   * there is a saved id and starting a fresh one otherwise.
   *
   * A cached thread is dropped when `config.model` has changed since it was
   * built (e.g. after `/reload` or `/pi_model`), so the next turn runs on the
   * model the config now names.
   */
  private getOrCreateThread(conversationKey: string): Thread {
    const cached = this.threads.get(conversationKey)
    if (cached && this.threadModels.get(conversationKey) === this.config.model) return cached

    const saved = this.store.get(conversationKey)
    // A cached thread already knows its id even when the store hasn't caught
    // up, so prefer it over the persisted one when rebuilding for a new model.
    const threadId = cached?.id ?? saved?.sessionId
    const thread = threadId
      ? this.codex.resumeThread(threadId, this.threadOptions())
      : this.codex.startThread(this.threadOptions())

    this.threads.set(conversationKey, thread)
    this.threadModels.set(conversationKey, this.config.model)
    return thread
  }

  private async publishUpdate(context: ToolContext, event: AgentTurnUpdate): Promise<void> {
    if (!context.onUpdate) return
    await context.onUpdate(event)
  }

  async runTurn(conversationKey: string, userText: string, context: ToolContext): Promise<string> {
    const thread = this.getOrCreateThread(conversationKey)
    const abort = new AbortController()
    this.abortControllers.set(conversationKey, abort)

    // A thread with no id has never taken a turn, so the pi-pipe instructions
    // aren't in its transcript yet. Every later turn — including one that
    // resumes the thread after a restart — replays them from Codex's history.
    const prompt =
      thread.id === null ? `${buildSystemPrompt(this.config)}\n\n---\n\n${userText}` : userText

    await this.publishUpdate(context, {
      kind: 'turn_started',
      conversationKey,
      message: 'Working on it...'
    })
    await this.transcript.log(conversationKey, { type: 'user', text: userText })

    // agent_message items keyed by item id, so a turn that emits several of
    // them (or updates one in place) renders as the full accumulated response
    // rather than only its latest fragment.
    const messagesByItemId = new Map<string, string>()
    const joinText = (): string =>
      [...messagesByItemId.values()]
        .map((t) => t.trim())
        .filter(Boolean)
        .join('\n\n')

    const startedItems = new Set<string>()
    let errorText = ''
    let aborted = false

    try {
      const { events } = await thread.runStreamed(prompt, { signal: abort.signal })
      for await (const event of events) {
        const text = await this.handleEvent(
          event,
          conversationKey,
          context,
          messagesByItemId,
          startedItems,
          joinText
        )
        if (text) errorText = text
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/abort/i.test(msg) || abort.signal.aborted) {
        aborted = true
      } else {
        errorText = msg
        this.logger.error('codex.turn_failed', { conversationKey, error: msg })
      }
    } finally {
      this.abortControllers.delete(conversationKey)
    }

    await this.publishUpdate(context, {
      kind: 'turn_finished',
      conversationKey,
      message: aborted ? 'Turn cancelled' : errorText ? 'Turn failed' : 'Turn finished'
    })

    const responseText = joinText()
    if (responseText) {
      await this.transcript.log(conversationKey, { type: 'assistant_text', text: responseText })
      this.logger.info('codex.turn_finished', { conversationKey })
      return responseText
    }
    if (aborted) return 'Cancelled.'
    if (errorText) return `Sorry, I hit an error: ${errorText.slice(0, 200)}`
    return 'I completed processing but have no response to return.'
  }

  /**
   * Translates one Codex event into transcript entries and channel updates.
   * Returns an error message when the event carries one, so the caller can
   * surface it if the turn produces no text.
   */
  private async handleEvent(
    event: ThreadEvent,
    conversationKey: string,
    context: ToolContext,
    messagesByItemId: Map<string, string>,
    startedItems: Set<string>,
    joinText: () => string
  ): Promise<string> {
    await this.transcript.log(conversationKey, { type: event.type })

    if (event.type === 'thread.started') {
      await this.store.set(conversationKey, { sessionId: event.thread_id })
      return ''
    }

    if (event.type === 'error') return event.message
    if (event.type === 'turn.failed') return event.error.message

    if (
      event.type !== 'item.started' &&
      event.type !== 'item.updated' &&
      event.type !== 'item.completed'
    ) {
      return ''
    }

    const item = event.item

    if (item.type === 'agent_message') {
      messagesByItemId.set(item.id, item.text)
      const text = joinText()
      await this.transcript.log(conversationKey, { type: 'assistant_text', text })
      await this.publishUpdate(context, {
        kind: 'text_streaming',
        conversationKey,
        message: 'Streaming response...',
        text
      })
      return ''
    }

    if (item.type === 'error') {
      this.logger.warn('codex.item_error', { conversationKey, message: item.message })
      return item.message
    }

    // Reasoning summaries are recorded but never pushed to a chat channel —
    // they'd bury the actual answer on a phone screen.
    if (item.type === 'reasoning') {
      await this.transcript.log(conversationKey, { type: 'reasoning', text: item.text })
      return ''
    }

    const described = describeItem(item)
    if (!described) return ''
    const { toolName, toolDetail } = described

    // Codex emits `item.completed` for some items (file_change) without a
    // preceding `item.started`, so synthesize the start the channels need to
    // render a status line before showing its result.
    if (!startedItems.has(item.id)) {
      startedItems.add(item.id)
      this.logger.info('codex.tool_call_started', {
        conversationKey,
        toolName,
        toolUseId: item.id,
        toolDetail
      })
      await this.publishUpdate(context, {
        kind: 'tool_call_started',
        conversationKey,
        message: `Using tool: ${toolName}`,
        toolName,
        toolUseId: item.id,
        ...(toolDetail ? { toolDetail } : {})
      })
    }

    if (event.type !== 'item.completed') return ''

    const failed = itemFailed(item)
    if (failed) {
      this.logger.warn('codex.tool_call_failed', { conversationKey, toolName, toolUseId: item.id })
    } else {
      this.logger.info('codex.tool_call_finished', {
        conversationKey,
        toolName,
        toolUseId: item.id
      })
    }
    await this.publishUpdate(context, {
      kind: failed ? 'tool_call_failed' : 'tool_call_finished',
      conversationKey,
      message: failed ? `Tool failed: ${toolName}` : `Tool completed: ${toolName}`,
      toolName,
      toolUseId: item.id,
      ...(toolDetail ? { toolDetail } : {})
    })

    // A failed command is worth surfacing when nothing else explains an empty
    // turn, but never overrides real assistant text.
    if (failed && item.type === 'command_execution') {
      return condense(item.aggregated_output || `command failed: ${item.command}`, 200)
    }
    if (failed && item.type === 'mcp_tool_call' && item.error) return item.error.message
    return ''
  }

  cancelTurn(conversationKey: string): void {
    this.abortControllers.get(conversationKey)?.abort()
    this.abortControllers.delete(conversationKey)
  }

  closeAll(): void {
    for (const ctrl of this.abortControllers.values()) ctrl.abort()
    this.abortControllers.clear()
    this.threads.clear()
    this.threadModels.clear()
  }

  async startNewSession(conversationKey: string): Promise<void> {
    this.abortControllers.get(conversationKey)?.abort()
    this.abortControllers.delete(conversationKey)
    this.threads.delete(conversationKey)
    this.threadModels.delete(conversationKey)
    await this.store.clear(conversationKey)
  }

  /**
   * Switches the model used for subsequent turns. Codex takes the model when a
   * thread is built, so cached threads are dropped and rebuilt (resuming the
   * same Codex thread id) on the next turn. Like the Claude harness, the model
   * string isn't validated here — the Codex CLI rejects an unknown model when
   * the next turn runs.
   */
  setModel(modelString: string): void {
    this.config.model = modelString
    // Leave the threads cached: getOrCreateThread sees the model mismatch and
    // rebuilds them from their existing ids, preserving conversation history.
    this.threadModels.clear()
  }
}

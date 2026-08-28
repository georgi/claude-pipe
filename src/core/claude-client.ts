import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

import type { PiPipeConfig } from '../config/schema.js'
import type { ModelClient } from './model-client.js'
import { SessionStore } from './session-store.js'
import { buildSystemPrompt } from './system-prompt.js'
import { TranscriptLogger } from './transcript-logger.js'
import { summarizeToolInput } from './tool-format.js'
import type { AgentTurnUpdate, Logger, ToolContext } from './types.js'

function summarizeToolResult(content: unknown): string {
  if (typeof content === 'string') {
    if (content.includes('API Error:')) return 'tool returned API error'
    return 'tool returned result'
  }
  return 'tool returned result'
}

/**
 * How a single `query()` stream ended.
 *
 * `stale_session` is the only outcome the caller can act on: the stored
 * `resume` id no longer resolves to a session on disk, so the turn is worth
 * retrying from scratch.
 */
type QueryOutcome =
  | { status: 'success'; text: string }
  | { status: 'cancelled'; text: string }
  | { status: 'failed'; text: string }
  | { status: 'stale_session' }

/**
 * Runs Claude via the official Claude Agent SDK, one `query()` call per turn.
 *
 * This is the Claude counterpart to {@link PiClient}: both satisfy the same
 * {@link ModelClient} contract, share the system prompt from
 * `./system-prompt.js`, and translate their SDK's stream into the agent loop's
 * {@link AgentTurnUpdate} events, so the surrounding app can't tell which
 * harness is active.
 *
 * Sessions resume across turns via the `session_id` from the result message,
 * persisted as a {@link SessionRef} `{ sessionId }`. Cancellation uses an
 * `AbortController` passed to `query()`.
 */
export class ClaudeClient implements ModelClient {
  private readonly transcript: TranscriptLogger
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
  }

  private async publishUpdate(context: ToolContext, event: AgentTurnUpdate): Promise<void> {
    if (!context.onUpdate) return
    await context.onUpdate(event)
  }

  private async handleMessage(
    message: SDKMessage,
    conversationKey: string,
    context: ToolContext,
    toolNamesByCallId: Map<string, string>,
    toolDetailsByCallId: Map<string, string>
  ): Promise<{ text: string }> {
    let text = ''

    await this.transcript.log(conversationKey, { type: message.type })

    if (message.type === 'assistant') {
      const content = message.message.content

      for (const block of content) {
        if (block.type === 'text') {
          // Accumulate so a message with multiple text blocks isn't truncated
          // to its last block, and streamed updates stay cumulative.
          text += block.text
          await this.transcript.log(conversationKey, { type: 'assistant_text', text })
          await this.publishUpdate(context, {
            kind: 'text_streaming',
            conversationKey,
            message: 'Streaming response...',
            text
          })
        } else if (block.type === 'tool_use') {
          if (block.id) toolNamesByCallId.set(block.id, block.name)
          const detail = summarizeToolInput(block.name, block.input)
          if (block.id && detail) toolDetailsByCallId.set(block.id, detail)
          this.logger.info('claude.tool_call_started', {
            conversationKey,
            toolName: block.name,
            toolUseId: block.id,
            toolDetail: detail
          })
          await this.publishUpdate(context, {
            kind: 'tool_call_started',
            conversationKey,
            message: `Using tool: ${block.name}`,
            toolName: block.name,
            ...(block.id ? { toolUseId: block.id } : {}),
            ...(detail ? { toolDetail: detail } : {})
          })
        }
      }
    }

    if (message.type === 'user') {
      const msgContent = message.message.content
      const blocks = Array.isArray(msgContent) ? msgContent : []
      for (const block of blocks) {
        if (
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          block.type === 'tool_result'
        ) {
          const toolResult = block as {
            type: 'tool_result'
            tool_use_id?: string
            content?: unknown
          }
          const toolUseId = toolResult.tool_use_id
          const toolName = toolUseId ? toolNamesByCallId.get(toolUseId) : undefined
          const toolDetail = toolUseId ? toolDetailsByCallId.get(toolUseId) : undefined
          const summary = summarizeToolResult(toolResult.content)
          const failed = summary.includes('error')

          if (failed) {
            this.logger.warn('claude.tool_call_failed', { conversationKey, toolName, toolUseId })
          } else {
            this.logger.info('claude.tool_call_finished', { conversationKey, toolName, toolUseId })
          }

          await this.publishUpdate(context, {
            kind: failed ? 'tool_call_failed' : 'tool_call_finished',
            conversationKey,
            message: failed
              ? `Tool failed${toolName ? `: ${toolName}` : ''}`
              : `Tool completed${toolName ? `: ${toolName}` : ''}`,
            ...(toolName ? { toolName } : {}),
            ...(toolUseId ? { toolUseId } : {}),
            ...(toolDetail ? { toolDetail } : {})
          })
        }
      }
    }

    return { text }
  }

  /**
   * Runs one `query()` stream to completion and reports how it ended, so
   * {@link runTurn} can decide whether a retry is worth it.
   */
  private async runQuery(
    conversationKey: string,
    userText: string,
    context: ToolContext,
    resumeSessionId: string | undefined,
    abort: AbortController
  ): Promise<QueryOutcome> {
    let responseText = ''
    const toolNamesByCallId = new Map<string, string>()
    const toolDetailsByCallId = new Map<string, string>()

    try {
      for await (const message of query({
        prompt: userText,
        options: {
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
          model: this.config.model,
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: buildSystemPrompt(this.config)
          },
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          cwd: this.config.workspace,
          abortController: abort
        }
      })) {
        const { text } = await this.handleMessage(
          message,
          conversationKey,
          context,
          toolNamesByCallId,
          toolDetailsByCallId
        )
        if (text) responseText = text

        if (message.type === 'result') {
          // A failed result with zero turns means the CLI never got as far as
          // running the conversation, so `session_id` names a session that was
          // never written to disk — usually the very `resume` id we passed
          // back. Persisting it would poison every later turn with the same
          // failure, so keep the mapping we already have.
          const sessionExists = !message.is_error || message.num_turns > 0
          if (sessionExists) {
            await this.store.set(conversationKey, { sessionId: message.session_id })
          }

          if (message.is_error) {
            this.logger.error('claude.turn_failed', {
              conversationKey,
              subtype: message.subtype,
              ...('errors' in message && message.errors.length ? { errors: message.errors } : {})
            })
            if (resumeSessionId && !sessionExists) return { status: 'stale_session' }
            return {
              status: 'failed',
              text: responseText || 'Sorry, I hit an error while processing that request.'
            }
          }

          this.logger.info('claude.turn_finished', { conversationKey })
          const finalText = 'result' in message ? message.result : ''
          return {
            status: 'success',
            text:
              responseText || finalText || 'I completed processing but have no response to return.'
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/abort/i.test(msg)) return { status: 'cancelled', text: responseText || 'Cancelled.' }
      this.logger.error('claude.turn_failed', { conversationKey, error: msg })
      return {
        status: 'failed',
        text: responseText || `Sorry, I hit an error: ${msg.slice(0, 200)}`
      }
    }

    // Stream ended without a result message.
    return {
      status: 'success',
      text: responseText || 'I completed processing but have no response to return.'
    }
  }

  async runTurn(conversationKey: string, userText: string, context: ToolContext): Promise<string> {
    const savedSession = this.store.get(conversationKey)
    const abort = new AbortController()
    this.abortControllers.set(conversationKey, abort)

    await this.publishUpdate(context, {
      kind: 'turn_started',
      conversationKey,
      message: 'Working on it...'
    })
    await this.transcript.log(conversationKey, { type: 'user', text: userText })

    try {
      let outcome = await this.runQuery(
        conversationKey,
        userText,
        context,
        savedSession?.sessionId,
        abort
      )

      // The stored session id no longer resolves (the transcript was pruned,
      // or the workspace/home moved). Drop it and start a fresh session rather
      // than failing this turn — and every turn after it — forever.
      if (outcome.status === 'stale_session') {
        this.logger.warn('claude.session_stale', {
          conversationKey,
          sessionId: savedSession?.sessionId
        })
        await this.store.clear(conversationKey)
        outcome = await this.runQuery(conversationKey, userText, context, undefined, abort)
        if (outcome.status === 'stale_session') {
          outcome = {
            status: 'failed',
            text: 'Sorry, I hit an error while processing that request.'
          }
        }
      }

      await this.publishUpdate(context, {
        kind: 'turn_finished',
        conversationKey,
        message:
          outcome.status === 'success'
            ? 'Turn finished'
            : outcome.status === 'cancelled'
              ? 'Turn cancelled'
              : 'Turn failed'
      })
      return outcome.text
    } finally {
      this.abortControllers.delete(conversationKey)
    }
  }

  cancelTurn(conversationKey: string): void {
    this.abortControllers.get(conversationKey)?.abort()
    this.abortControllers.delete(conversationKey)
  }

  closeAll(): void {
    for (const ctrl of this.abortControllers.values()) ctrl.abort()
    this.abortControllers.clear()
  }

  async startNewSession(conversationKey: string): Promise<void> {
    await this.store.clear(conversationKey)
  }

  /**
   * Switches the model used for subsequent turns. The Claude SDK takes the
   * model per `query()` call, so this just updates the shared config; the next
   * turn picks it up. Kept symmetric with {@link PiClient.setModel} so the
   * `/pi_model` command works regardless of the active harness.
   */
  setModel(modelString: string): void {
    this.config.model = modelString
  }
}

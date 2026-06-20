import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

import type { PiPipeConfig } from '../config/schema.js'
import { getConfigDir } from '../config/settings.js'
import type { ModelClient } from './model-client.js'
import { SessionStore } from './session-store.js'
import { buildSystemPrompt } from './system-prompt.js'
import { TranscriptLogger } from './transcript-logger.js'
import { Guardrail } from './guardrail.js'
import type { AgentTurnUpdate, Logger, ToolContext } from './types.js'

/** Filesystem-mutating / command-execution tools blocked in sandbox mode. */
const SANDBOX_DISALLOWED_TOOLS = ['Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']

function summarizeToolResult(content: unknown): string {
  if (typeof content === 'string') {
    if (content.includes('API Error:')) return 'tool returned API error'
    return 'tool returned result'
  }
  return 'tool returned result'
}

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
  }

  private async publishUpdate(context: ToolContext, event: AgentTurnUpdate): Promise<void> {
    if (!context.onUpdate) return
    await context.onUpdate(event)
  }

  private async handleMessage(
    message: SDKMessage,
    conversationKey: string,
    context: ToolContext,
    toolNamesByCallId: Map<string, string>
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
          this.logger.info('claude.tool_call_started', {
            conversationKey,
            toolName: block.name,
            toolUseId: block.id
          })
          await this.publishUpdate(context, {
            kind: 'tool_call_started',
            conversationKey,
            message: `Using tool: ${block.name}`,
            toolName: block.name,
            ...(block.id ? { toolUseId: block.id } : {})
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
            ...(toolUseId ? { toolUseId } : {})
          })
        }
      }
    }

    return { text }
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

    let responseText = ''
    const toolNamesByCallId = new Map<string, string>()

    try {
      for await (const message of query({
        prompt: userText,
        options: {
          ...(savedSession?.sessionId ? { resume: savedSession.sessionId } : {}),
          model: this.config.model,
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: buildSystemPrompt(this.config)
          },
          // Sandbox mode enforces the shared guardrail (block mutating tools +
          // sensitive reads) via canUseTool; otherwise grant full access so the
          // assistant can edit files and run commands as documented.
          ...(this.config.sandbox
            ? {
                disallowedTools: SANDBOX_DISALLOWED_TOOLS,
                canUseTool: async (toolName: string, input: Record<string, unknown>) => {
                  const decision = this.guardrail.evaluate(toolName, input)
                  return decision.blocked
                    ? {
                        behavior: 'deny' as const,
                        message: decision.reason ?? 'Blocked in sandbox mode.'
                      }
                    : { behavior: 'allow' as const, updatedInput: input }
                }
              }
            : { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }),
          cwd: this.config.workspace,
          abortController: abort
        }
      })) {
        const { text } = await this.handleMessage(
          message,
          conversationKey,
          context,
          toolNamesByCallId
        )
        if (text) responseText = text

        if (message.type === 'result') {
          await this.store.set(conversationKey, { sessionId: message.session_id })

          if (message.is_error) {
            this.logger.error('claude.turn_failed', { conversationKey, subtype: message.subtype })
            await this.publishUpdate(context, {
              kind: 'turn_finished',
              conversationKey,
              message: 'Turn failed'
            })
            return 'Sorry, I hit an error while processing that request.'
          }

          this.logger.info('claude.turn_finished', { conversationKey })
          await this.publishUpdate(context, {
            kind: 'turn_finished',
            conversationKey,
            message: 'Turn finished'
          })

          const finalText = 'result' in message ? message.result : ''
          return (
            responseText || finalText || 'I completed processing but have no response to return.'
          )
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/abort/i.test(msg)) {
        await this.publishUpdate(context, {
          kind: 'turn_finished',
          conversationKey,
          message: 'Turn cancelled'
        })
        return responseText || 'Cancelled.'
      }
      this.logger.error('claude.turn_failed', { conversationKey, error: msg })
      await this.publishUpdate(context, {
        kind: 'turn_finished',
        conversationKey,
        message: 'Turn failed'
      })
      return responseText || `Sorry, I hit an error: ${msg.slice(0, 200)}`
    } finally {
      this.abortControllers.delete(conversationKey)
    }

    return responseText || 'I completed processing but have no response to return.'
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

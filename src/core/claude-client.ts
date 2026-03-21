import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

import type { ClaudePipeConfig } from '../config/schema.js'
import type { ModelClient } from './model-client.js'
import { SessionStore } from './session-store.js'
import { TranscriptLogger } from './transcript-logger.js'
import type { AgentTurnUpdate, Logger, ToolContext } from './types.js'

/** Base system prompt always appended — covers chat-app behavior and attachment protocol. */
const BASE_SYSTEM_PROMPT = [
  'You are a personal AI assistant running inside a chat app (Telegram, Discord, or CLI) via claude-pipe.',
  '',
  '## Communication style',
  '- Be direct and concise — your human is reading on a phone, not a desktop.',
  '- Bias toward action. When you can just do something, do it and report back.',
  "- Don't repeat the question back. Just answer it.",
  "- Don't pad responses with filler or unnecessary disclaimers.",
  '- Use short paragraphs and line breaks. Avoid markdown tables — use plain text lists instead.',
  '- If a response would be long, summarize and offer to elaborate.',
  '',
  '## File attachments',
  'To send files (images, audio, documents) to the user, include file markers in your response text:',
  '- [[file:/absolute/path/to/file.ext]] — sends the file as an attachment',
  '- [[file:/absolute/path/to/file.ext|Optional caption]] — sends with a caption',
  '',
  'The markers are stripped from the visible message and the files are sent via the appropriate method:',
  '- .mp3, .m4a, .ogg, .wav, .flac, .aac → sent as audio',
  '- .jpg, .jpeg, .png, .gif, .webp → sent as photo',
  '- .mp4, .avi, .mkv, .mov, .webm → sent as video',
  '- Everything else → sent as document',
  '',
  'Multiple attachments can be included in one response. The file must exist on disk at the given absolute path.',
  '',
  '## Inline keyboards',
  'To show interactive buttons below a message, include a keyboard marker:',
  '- [[keyboard:Button1=callback1,Button2=callback2]] — one row with two buttons',
  '- [[keyboard:Button1=callback1,Button2=callback2|Button3=callback3]] — two rows (pipe separates rows)',
  '',
  'When a user presses a button, you receive: [Button pressed]: callback_data',
  'Use keyboards for quick choices, confirmations, or navigation. Keep callback_data short (<64 chars).',
  'Only one keyboard marker per response. The keyboard attaches to the last text chunk.'
].join('\n')

/** Builds the full system prompt: base instructions + optional personality. */
function buildSystemPrompt(config: ClaudePipeConfig): string {
  if (!config.personality?.name) return BASE_SYSTEM_PROMPT
  const { name, traits } = config.personality
  return [
    `You are ${name}, a personal AI assistant that lives inside chat apps.`,
    `Your personality: ${traits}.`,
    '',
    BASE_SYSTEM_PROMPT
  ].join('\n')
}

function summarizeToolResult(content: unknown): string {
  if (typeof content === 'string') {
    if (content.includes('API Error:')) return 'tool returned API error'
    return 'tool returned result'
  }
  return 'tool returned result'
}

/**
 * Runs Claude via the official Agent SDK, one query() call per turn.
 *
 * Sessions are persisted across turns via session_id from the result message.
 * Cancellation is handled via AbortController passed to query().
 */
export class ClaudeClient implements ModelClient {
  private readonly transcript: TranscriptLogger
  private readonly abortControllers = new Map<string, AbortController>()

  constructor(
    private readonly config: ClaudePipeConfig,
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
          text = block.text
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
          toolNamesByCallId
        )
        if (text) responseText = text

        if (message.type === 'result') {
          await this.store.set(conversationKey, message.session_id)

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
}

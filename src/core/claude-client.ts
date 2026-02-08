import {
  query,
  type SDKMessage
} from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { MicroclawConfig } from '../config/schema.js'
import { SessionStore } from './session-store.js'
import { TranscriptLogger } from './transcript-logger.js'
import type { Logger } from './types.js'

type AssistantTextBlock = { type: 'text'; text: string }

function getClaudeCodeExecutablePath(): string {
  const localPath = join(homedir(), '.claude', 'local', 'claude')
  if (existsSync(localPath)) return localPath
  return 'claude'
}

function isTextBlock(block: unknown): block is AssistantTextBlock {
  if (!block || typeof block !== 'object') return false
  const candidate = block as { type?: unknown; text?: unknown }
  return candidate.type === 'text' && typeof candidate.text === 'string'
}

function extractSessionId(msg: SDKMessage): string | undefined {
  return 'session_id' in msg ? (msg.session_id as string | undefined) : undefined
}

function getAssistantText(msg: SDKMessage): string {
  if (msg.type !== 'assistant') return ''
  return (msg.message.content as unknown[])
    .filter((block: unknown) => isTextBlock(block))
    .map((block: AssistantTextBlock) => block.text)
    .join('')
}

/**
 * Manages Claude SDK V1 query execution and session resume.
 *
 * Session IDs are persisted by normalized conversation key (`channel:chat_id`)
 * and passed back via the `resume` option on subsequent turns.
 */
export class ClaudeClient {
  private readonly transcript: TranscriptLogger

  constructor(
    private readonly config: MicroclawConfig,
    private readonly store: SessionStore,
    private readonly logger: Logger
  ) {
    const transcriptOptions = {
      enabled: this.config.transcriptLog.enabled,
      path: this.config.transcriptLog.path,
      ...(this.config.transcriptLog.maxBytes != null
        ? { maxBytes: this.config.transcriptLog.maxBytes }
        : {}),
      ...(this.config.transcriptLog.maxFiles != null
        ? { maxFiles: this.config.transcriptLog.maxFiles }
        : {})
    }

    this.transcript = new TranscriptLogger(transcriptOptions)
  }

  /**
   * Executes a single conversational turn with tool support.
   */
  async runTurn(conversationKey: string, userText: string, _context: unknown): Promise<string> {
    const savedSession = this.store.get(conversationKey)
    const queryOptions = {
      model: this.config.model,
      cwd: this.config.workspace,
      pathToClaudeCodeExecutable: getClaudeCodeExecutablePath(),
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      tools: { type: 'preset' as const, preset: 'claude_code' as const },
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append:
          'You are microclaw. Use Claude Agent SDK built-in tools for file/web/shell operations when needed. ' +
          'For normal chat replies, return direct text responses.'
      },
      ...(savedSession ? { resume: savedSession.sessionId } : {})
    }

    const stream = query({
      prompt: userText,
      options: queryOptions
    })

    let responseText = ''
    let observedSessionId: string | undefined = savedSession?.sessionId

    try {
      await this.transcript.log(conversationKey, { type: 'user', text: userText })

      for await (const msg of stream) {
        const sid = extractSessionId(msg)
        if (sid) observedSessionId = sid

        await this.transcript.log(conversationKey, { type: msg.type })

        if (msg.type === 'assistant') {
          const assistantText = getAssistantText(msg)
          if (assistantText) {
            responseText = assistantText
            await this.transcript.log(conversationKey, {
              type: 'assistant_text',
              text: assistantText
            })
          }
        }

        if (msg.type === 'result') {
          if (msg.is_error) {
            this.logger.warn('claude.result_error', {
              conversationKey,
              subtype: msg.subtype,
              errors: 'errors' in msg ? msg.errors : undefined
            })
          }
          break
        }
      }

      if (observedSessionId) {
        await this.store.set(conversationKey, observedSessionId)
      }

      return responseText || 'I completed processing but have no response to return.'
    } catch (error) {
      this.logger.error('claude.turn_failed', {
        conversationKey,
        error: error instanceof Error ? error.message : String(error)
      })
      return 'Sorry, I hit an error while processing that request.'
    }
  }

  /** Closes all live sessions and releases process resources. */
  closeAll(): void {
    // No-op for SDK V1 query() mode: each turn uses a fresh query stream.
  }

  /** Clears persisted session mapping so the next turn starts a fresh Claude session. */
  async startNewSession(conversationKey: string): Promise<void> {
    await this.store.clear(conversationKey)
  }
}

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { MicroclawConfig } from '../config/schema.js'
import { SessionStore } from './session-store.js'
import { TranscriptLogger } from './transcript-logger.js'
import type { AgentTurnUpdate, Logger, ToolContext } from './types.js'

type JsonRecord = Record<string, unknown>
type AssistantTextBlock = { type: 'text'; text: string }
type AssistantToolUseBlock = {
  type: 'tool_use'
  name: string
  id?: string
}
type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id?: string
  content?: unknown
}

function getClaudeCodeExecutablePath(): string {
  const localPath = join(homedir(), '.claude', 'local', 'claude')
  if (existsSync(localPath)) return localPath
  return 'claude'
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object'
}

function isTextBlock(block: unknown): block is AssistantTextBlock {
  if (!isRecord(block)) return false
  return block.type === 'text' && typeof block.text === 'string'
}

function isToolUseBlock(block: unknown): block is AssistantToolUseBlock {
  if (!isRecord(block)) return false
  return block.type === 'tool_use' && typeof block.name === 'string'
}

function isToolResultBlock(block: unknown): block is ToolResultBlock {
  if (!isRecord(block)) return false
  return block.type === 'tool_result'
}

function truncate(value: string, max = 2000): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}...(truncated)`
}

function summarizeToolResult(content: unknown): string {
  if (typeof content === 'string') {
    if (content.includes('API Error:')) return 'tool returned API error'
    return 'tool returned result'
  }
  return 'tool returned result'
}

/**
 * Runs Claude Code through subprocess `stream-json` output and persists session IDs.
 */
export class ClaudeClient {
  private readonly transcript: TranscriptLogger

  constructor(
    private readonly config: MicroclawConfig,
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

  private async publishUpdate(
    context: ToolContext,
    event: AgentTurnUpdate
  ): Promise<void> {
    if (!context.onUpdate) return
    await context.onUpdate(event)
  }

  /**
   * Executes one turn by spawning the Claude CLI and parsing `stream-json` frames.
   */
  async runTurn(
    conversationKey: string,
    userText: string,
    context: ToolContext
  ): Promise<string> {
    const savedSession = this.store.get(conversationKey)
    const executable = getClaudeCodeExecutablePath()
    const args = [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--permission-mode',
      'bypassPermissions',
      '--dangerously-skip-permissions',
      '--model',
      this.config.model
    ]

    if (savedSession?.sessionId) {
      args.push('--resume', savedSession.sessionId)
    }
    args.push(userText)

    await this.publishUpdate(context, {
      kind: 'turn_started',
      conversationKey,
      message: 'Working on it...'
    })
    await this.transcript.log(conversationKey, { type: 'user', text: userText })

    const child = spawn(executable, args, {
      cwd: this.config.workspace,
      env: process.env
    })
    this.logger.info('claude.spawn_start', {
      conversationKey,
      executable,
      args
    })
    child.stdin.end()

    let stdoutBuffer = ''
    let stderrBuffer = ''
    let stderrLineBuffer = ''
    let responseText = ''
    let fallbackResultText = ''
    let observedSessionId = savedSession?.sessionId
    let resultIsError = false
    const toolNamesByCallId = new Map<string, string>()
    let frameChain = Promise.resolve()

    const handleFrame = async (frame: unknown): Promise<void> => {
      if (!isRecord(frame) || typeof frame.type !== 'string') return

      if (typeof frame.session_id === 'string' && frame.session_id) {
        observedSessionId = frame.session_id
      }

      await this.transcript.log(conversationKey, { type: frame.type })

      if (frame.type === 'assistant') {
        const message = isRecord(frame.message) ? frame.message : undefined
        const content = Array.isArray(message?.content) ? message.content : []
        const text = content
          .filter((block: unknown) => isTextBlock(block))
          .map((block: AssistantTextBlock) => block.text)
          .join('')
        if (text) {
          responseText = text
          await this.transcript.log(conversationKey, {
            type: 'assistant_text',
            text
          })
        }

        for (const block of content.filter((entry: unknown) => isToolUseBlock(entry))) {
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

      if (frame.type === 'user') {
        const message = isRecord(frame.message) ? frame.message : undefined
        const content = Array.isArray(message?.content) ? message.content : []
        for (const block of content.filter((entry: unknown) => isToolResultBlock(entry))) {
          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
          const toolName = toolUseId ? toolNamesByCallId.get(toolUseId) : undefined
          const summary = summarizeToolResult(block.content)
          const failed = summary.includes('error')

          if (failed) {
            this.logger.warn('claude.tool_call_failed', {
              conversationKey,
              toolName,
              toolUseId
            })
          } else {
            this.logger.info('claude.tool_call_finished', {
              conversationKey,
              toolName,
              toolUseId
            })
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

      if (frame.type === 'result') {
        resultIsError = frame.is_error === true
        if (typeof frame.result === 'string' && frame.result) {
          fallbackResultText = frame.result
        }
      }
    }

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString()
      let newlineIndex = stdoutBuffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const rawLine = stdoutBuffer.slice(0, newlineIndex)
        const line = rawLine.trim()
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
        if (line) {
          this.logger.info('claude.stdout', {
            conversationKey,
            line
          })
          frameChain = frameChain
            .then(async () => {
              const parsed = JSON.parse(line) as unknown
              await handleFrame(parsed)
            })
            .catch((error: unknown) => {
              this.logger.warn('claude.stream_frame_parse_failed', {
                conversationKey,
                error: error instanceof Error ? error.message : String(error),
                line: truncate(line)
              })
            })
        }
        newlineIndex = stdoutBuffer.indexOf('\n')
      }
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      stderrBuffer += text
      stderrLineBuffer += text
      let newlineIndex = stderrLineBuffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = stderrLineBuffer.slice(0, newlineIndex).trim()
        stderrLineBuffer = stderrLineBuffer.slice(newlineIndex + 1)
        if (line) {
          this.logger.info('claude.stderr', {
            conversationKey,
            line
          })
        }
        newlineIndex = stderrLineBuffer.indexOf('\n')
      }
    })

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ code, signal }))
      }
    ).catch((error: unknown) => {
      throw new Error(
        `failed to start claude cli: ${error instanceof Error ? error.message : String(error)}`
      )
    })

    if (stdoutBuffer.trim()) {
      this.logger.info('claude.stdout', {
        conversationKey,
        line: stdoutBuffer.trim()
      })
      frameChain = frameChain
        .then(async () => {
          const parsed = JSON.parse(stdoutBuffer.trim()) as unknown
          await handleFrame(parsed)
        })
        .catch((error: unknown) => {
          this.logger.warn('claude.stream_frame_parse_failed', {
            conversationKey,
            error: error instanceof Error ? error.message : String(error),
            line: truncate(stdoutBuffer.trim())
          })
        })
    }

    await frameChain

    if (stderrLineBuffer.trim()) {
      this.logger.info('claude.stderr', {
        conversationKey,
        line: stderrLineBuffer.trim()
      })
    }

    if (stderrBuffer.trim()) {
      this.logger.info('claude.stderr_summary', {
        conversationKey,
        bytes: stderrBuffer.length
      })
    }

    const failed =
      resultIsError || (exit.code !== 0 && exit.code !== null) || exit.signal !== null
    if (failed) {
      this.logger.error('claude.turn_failed', {
        conversationKey,
        exitCode: exit.code,
        signal: exit.signal,
        hadResultError: resultIsError
      })
      await this.publishUpdate(context, {
        kind: 'turn_finished',
        conversationKey,
        message: 'Turn failed'
      })
      return 'Sorry, I hit an error while processing that request.'
    }

    if (observedSessionId) {
      await this.store.set(conversationKey, observedSessionId)
    }

    this.logger.info('claude.spawn_exit', {
      conversationKey,
      exitCode: exit.code,
      signal: exit.signal,
      resultIsError
    })

    await this.publishUpdate(context, {
      kind: 'turn_finished',
      conversationKey,
      message: 'Turn finished'
    })

    return responseText || fallbackResultText || 'I completed processing but have no response to return.'
  }

  /** No-op in subprocess-per-turn mode. */
  closeAll(): void {}

  /** Clears persisted session mapping so the next turn starts a fresh Claude session. */
  async startNewSession(conversationKey: string): Promise<void> {
    await this.store.clear(conversationKey)
  }
}

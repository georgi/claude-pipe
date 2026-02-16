import { spawn } from 'node:child_process'

import type { ClaudePipeConfig } from '../config/schema.js'
import type { ModelClient } from './model-client.js'
import { SessionStore } from './session-store.js'
import { TranscriptLogger } from './transcript-logger.js'
import type { Attachment, AgentTurnUpdate, Logger, ToolContext } from './types.js'
import {
  type CodexAskForApproval,
  type CodexThreadItem,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcSuccess,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isJsonRpcServerRequest
} from './codex-rpc.js'

type JsonRecord = Record<string, unknown>

interface CodexRuntimeOptions {
  command: string
  args: string[]
  approvalPolicy: CodexAskForApproval
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  modelProvider?: string
  apiKeyEnvVar: string
}

interface RpcPending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object'
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function truncate(value: string, max = 2000): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}...(truncated)`
}

function parseCodexArgs(input: string | undefined): string[] {
  if (!input) return ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never', 'app-server']
  const trimmed = input.trim()
  if (!trimmed) return ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never', 'app-server']
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed
    } catch {
      // fall through to whitespace split
    }
  }
  return trimmed.split(/\s+/).filter(Boolean)
}

function buildRuntimeOptions(): CodexRuntimeOptions {
  const command = process.env.CLAUDEPIPE_CODEX_COMMAND?.trim() || 'codex'
  const args = parseCodexArgs(process.env.CLAUDEPIPE_CODEX_ARGS)
  const policyRaw = process.env.CLAUDEPIPE_CODEX_APPROVAL_POLICY?.trim() || 'never'
  const approvalPolicy: CodexAskForApproval =
    policyRaw === 'untrusted' || policyRaw === 'on-failure' || policyRaw === 'on-request'
      ? policyRaw
      : 'never'
  const sandboxRaw = process.env.CLAUDEPIPE_CODEX_SANDBOX?.trim() || 'danger-full-access'
  const sandboxMode =
    sandboxRaw === 'read-only' || sandboxRaw === 'danger-full-access'
      ? sandboxRaw
      : 'workspace-write'
  return {
    command,
    args,
    approvalPolicy,
    sandboxMode,
    ...(process.env.CLAUDEPIPE_CODEX_MODEL_PROVIDER
      ? { modelProvider: process.env.CLAUDEPIPE_CODEX_MODEL_PROVIDER }
      : {}),
    apiKeyEnvVar: process.env.CLAUDEPIPE_CODEX_API_KEY_ENV_VAR || 'OPENAI_API_KEY'
  }
}

function itemToolName(item: CodexThreadItem): string | undefined {
  if (item.type === 'commandExecution') return 'exec'
  if (item.type === 'fileChange') return 'apply_patch'
  if (item.type === 'mcpToolCall') return `${item.server}/${item.tool}`
  if (item.type === 'webSearch') return 'web_search'
  return undefined
}

function commandProgressLabel(command: string): string {
  const [rawBinary] = command.trim().split(/\s+/)
  const binary = rawBinary?.split('/').pop()?.toLowerCase() ?? ''
  const action = binary ? `Exec ${binary}` : 'Exec command'
  const fullCommand = JSON.stringify(command.trim() || command)
  return `${action}: ${fullCommand}`
}

function toolProgressMessage(item: CodexThreadItem): string {
  if (item.type === 'commandExecution') {
    return commandProgressLabel(asString(item.command) ?? '')
  }
  return `Using tool: ${itemToolName(item) ?? item.type}`
}

function toolFailureMessage(item: CodexThreadItem): string {
  if (item.type === 'commandExecution') {
    const action = commandProgressLabel(asString(item.command) ?? '')
    return `Failed: ${action}`
  }
  const toolName = itemToolName(item) ?? item.type
  return `Tool failed: ${toolName}`
}

function itemUseId(item: CodexThreadItem): string | undefined {
  if (typeof item.id === 'string') return item.id
  return undefined
}

function isFailedItem(item: CodexThreadItem): boolean {
  if (item.type === 'commandExecution') return item.status === 'failed'
  if (item.type === 'fileChange') return item.status === 'failed'
  if (item.type === 'mcpToolCall') return item.status === 'failed'
  return false
}

/**
 * Runs Codex CLI in app-server mode over JSON-RPC (stdio, NDJSON framing).
 */
export class CodexClient implements ModelClient {
  private readonly transcript: TranscriptLogger
  private readonly runtime: CodexRuntimeOptions

  constructor(
    private readonly config: ClaudePipeConfig,
    private readonly store: SessionStore,
    private readonly logger: Logger
  ) {
    this.runtime = buildRuntimeOptions()
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

  async runTurn(
    conversationKey: string,
    userText: string,
    context: ToolContext,
    attachments?: Attachment[]
  ): Promise<string> {
    const savedSession = this.store.get(conversationKey)
    const env = { ...process.env }
    const configuredApiKey = env[this.runtime.apiKeyEnvVar]
    if (configuredApiKey && !env.OPENAI_API_KEY) {
      env.OPENAI_API_KEY = configuredApiKey
    }

    await this.publishUpdate(context, {
      kind: 'turn_started',
      conversationKey,
      message: 'Working on it...'
    })

    // Enhance user text with attachment descriptions when attachments are present
    let enhancedUserText = userText
    if (attachments && attachments.length > 0) {
      const attachmentDescriptions = attachments
        .map((att) => {
          const filename = att.filename || att.path?.split('/').pop() || 'file'
          const location = att.path ? ` at ${att.path}` : att.url ? ` (URL: ${att.url})` : ''
          return `[User sent ${att.type}: ${filename}${location}]`
        })
        .join('\n')
      enhancedUserText = `${attachmentDescriptions}\n\n${userText}`
    }

    await this.transcript.log(conversationKey, { type: 'user', text: enhancedUserText })

    const child = spawn(this.runtime.command, this.runtime.args, {
      cwd: this.config.workspace,
      env
    })

    this.logger.info('codex.spawn_start', {
      conversationKey,
      executable: this.runtime.command,
      args: this.runtime.args
    })

    let stdoutBuffer = ''
    let stderrBuffer = ''
    let stderrLineBuffer = ''
    let responseText = ''
    let observedThreadId = savedSession?.sessionId
    let observedTurnId: string | undefined
    let turnFailed = false
    let heartbeatSeen = false
    let idCounter = 0
    const pending = new Map<JsonRpcId, RpcPending>()
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined
    let frameChain = Promise.resolve()

    let resolveTurnDone: ((value: void | PromiseLike<void>) => void) | undefined
    let rejectTurnDone: ((reason?: unknown) => void) | undefined
    let turnDoneSettled = false
    const turnDone = new Promise<void>((resolve, reject) => {
      resolveTurnDone = (value) => {
        if (turnDoneSettled) return
        turnDoneSettled = true
        resolve(value)
      }
      rejectTurnDone = (reason) => {
        if (turnDoneSettled) return
        turnDoneSettled = true
        reject(reason)
      }
    })

    const rejectAllPending = (error: Error): void => {
      for (const entry of pending.values()) {
        entry.reject(error)
      }
      pending.clear()
      if (rejectTurnDone) rejectTurnDone(error)
    }

    const writeMessage = (message: unknown): void => {
      const line = `${JSON.stringify(message)}\n`
      child.stdin.write(line)
      this.logger.info('codex.stdin', { conversationKey, line: truncate(line.trim()) })
    }

    const request = <TResult>(method: string, params: unknown): Promise<TResult> => {
      const id = ++idCounter
      writeMessage({ jsonrpc: '2.0', id, method, params })
      return new Promise<TResult>((resolve, reject) => {
        pending.set(id, {
          resolve: (value: unknown) => resolve(value as TResult),
          reject
        })
      })
    }

    const respondServerRequest = (id: JsonRpcId, result: unknown): void => {
      writeMessage({ jsonrpc: '2.0', id, result })
    }

    const handleServerRequest = async (msg: {
      method: string
      id: JsonRpcId
      params?: unknown
    }): Promise<void> => {
      const params = asRecord(msg.params) ?? {}
      if (msg.method === 'item/commandExecution/requestApproval') {
        this.logger.info('codex.approval.exec.request', {
          conversationKey,
          command: asString(params.command) ?? '',
          cwd: asString(params.cwd) ?? ''
        })
        respondServerRequest(msg.id, { decision: 'accept' })
        return
      }
      if (msg.method === 'item/fileChange/requestApproval') {
        this.logger.info('codex.approval.patch.request', { conversationKey })
        respondServerRequest(msg.id, { decision: 'accept' })
        return
      }
      if (msg.method === 'item/tool/requestUserInput') {
        const answers: Record<string, { answers: string[] }> = {}
        const questions = Array.isArray(params.questions) ? params.questions : []
        for (const question of questions) {
          const entry = asRecord(question)
          const id = asString(entry?.id)
          if (id) answers[id] = { answers: [] }
        }
        respondServerRequest(msg.id, { answers })
        return
      }

      this.logger.warn('codex.server_request.unhandled', {
        conversationKey,
        method: msg.method
      })
      writeMessage({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `unsupported method: ${msg.method}` }
      })
    }

    const handleNotification = async (notification: {
      method: string
      params?: unknown
    }): Promise<void> => {
      const params = asRecord(notification.params) ?? {}
      await this.transcript.log(conversationKey, {
        type: 'rpc_notification',
        method: notification.method
      })

      if (notification.method === 'thread/started') {
        const thread = asRecord(params.thread)
        const threadId = asString(thread?.id)
        if (threadId) observedThreadId = threadId
        return
      }

      if (notification.method === 'turn/started') {
        const turn = asRecord(params.turn)
        const turnId = asString(turn?.id)
        if (turnId) observedTurnId = turnId
        return
      }

      if (notification.method === 'item/agentMessage/delta') {
        const delta = asString(params.delta)
        if (delta) responseText += delta
        return
      }

      if (notification.method === 'item/commandExecution/outputDelta') {
        heartbeatSeen = true
        return
      }

      if (notification.method === 'item/mcpToolCall/progress') {
        const itemId = asString(params.itemId)
        const progress = asString(params.message) ?? 'MCP tool in progress'
        heartbeatSeen = true
        await this.publishUpdate(context, {
          kind: 'tool_call_started',
          conversationKey,
          message: progress,
          toolName: 'mcp',
          ...(itemId ? { toolUseId: itemId } : {})
        })
        return
      }

      if (notification.method === 'item/started') {
        const item = asRecord(params.item)
        if (!item) return
        const codexItem = item as CodexThreadItem
        const toolName = itemToolName(codexItem)
        if (!toolName) return
        const useId = itemUseId(codexItem)
        await this.publishUpdate(context, {
          kind: 'tool_call_started',
          conversationKey,
          message: toolProgressMessage(codexItem),
          toolName,
          ...(useId ? { toolUseId: useId } : {})
        })
        return
      }

      if (notification.method === 'item/completed') {
        const item = asRecord(params.item)
        if (!item) return
        const codexItem = item as CodexThreadItem
        const toolName = itemToolName(codexItem)
        if (!toolName) return
        const failed = isFailedItem(codexItem)
        if (failed) {
          const useId = itemUseId(codexItem)
          await this.publishUpdate(context, {
            kind: 'tool_call_failed',
            conversationKey,
            message: toolFailureMessage(codexItem),
            toolName,
            ...(useId ? { toolUseId: useId } : {})
          })
        }
        return
      }

      if (notification.method === 'turn/completed') {
        const turn = asRecord(params.turn)
        turnFailed = asString(turn?.status) === 'failed'
        const errorObj = asRecord(turn?.error)
        if (asString(errorObj?.message)) {
          this.logger.error('codex.turn.error', {
            conversationKey,
            message: asString(errorObj?.message)
          })
        }
        if (resolveTurnDone) resolveTurnDone()
        return
      }

      if (notification.method === 'error') {
        this.logger.warn('codex.notification.error', {
          conversationKey,
          payload: notification.params
        })
      }
    }

    const handleLine = async (line: string): Promise<void> => {
      const parsed = JSON.parse(line) as unknown
      if (isJsonRpcResponse(parsed)) {
        const response = parsed as JsonRpcSuccess | JsonRpcFailure
        const slot = pending.get(response.id)
        if (!slot) return
        pending.delete(response.id)
        if ('error' in response) {
          slot.reject(
            new Error(
              `codex rpc error (${response.error.code}): ${response.error.message}`
            )
          )
        } else {
          slot.resolve(response.result)
        }
        return
      }

      if (isJsonRpcServerRequest(parsed)) {
        const requestMsg = parsed as { method: string; id: JsonRpcId; params?: unknown }
        await handleServerRequest(requestMsg)
        return
      }

      if (isJsonRpcNotification(parsed)) {
        const notification = parsed as { method: string; params?: unknown }
        await handleNotification(notification)
        return
      }

      this.logger.warn('codex.stdout.unclassified', {
        conversationKey,
        line: truncate(line)
      })
    }

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString()
      let newlineIndex = stdoutBuffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const rawLine = stdoutBuffer.slice(0, newlineIndex)
        const line = rawLine.trim()
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
        if (line) {
          this.logger.info('codex.stdout', { conversationKey, line })
          frameChain = frameChain
            .then(() => handleLine(line))
            .catch((error: unknown) => {
              this.logger.warn('codex.stream_frame_parse_failed', {
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
          this.logger.info('codex.stderr', { conversationKey, line })
        }
        newlineIndex = stderrLineBuffer.indexOf('\n')
      }
    })

    child.on('error', (error: Error) => {
      rejectAllPending(new Error(`failed to start codex app-server: ${error.message}`))
    })
    child.on('close', (code, signal) => {
      exitInfo = { code, signal }
      if (!turnDoneSettled && code === 0 && signal == null && resolveTurnDone) {
        resolveTurnDone()
      }
      if (code !== 0 && !turnFailed) {
        rejectAllPending(new Error(`codex exited with code ${String(code)} signal ${String(signal)}`))
      }
    })

    try {
      await request('initialize', {
        clientInfo: {
          name: 'claude-pipe',
          title: 'claude-pipe',
          version: '0.1.0'
        },
        capabilities: { experimentalApi: false }
      })

      const threadResponse = savedSession?.sessionId
        ? await request<{ thread: { id: string } }>('thread/resume', {
            threadId: savedSession.sessionId,
            cwd: context.workspace,
            model: this.config.model,
            approvalPolicy: this.runtime.approvalPolicy,
            sandbox: this.runtime.sandboxMode,
            ...(this.runtime.modelProvider ? { modelProvider: this.runtime.modelProvider } : {})
          })
        : await request<{ thread: { id: string } }>('thread/start', {
            cwd: context.workspace,
            model: this.config.model,
            approvalPolicy: this.runtime.approvalPolicy,
            sandbox: this.runtime.sandboxMode,
            experimentalRawEvents: false,
            ...(this.runtime.modelProvider ? { modelProvider: this.runtime.modelProvider } : {})
          })

      observedThreadId = threadResponse.thread.id

      await request('turn/start', {
        threadId: observedThreadId,
        input: [
          {
            type: 'text',
            text: `Workspace: ${context.workspace}\n\n${enhancedUserText}`,
            text_elements: []
          }
        ],
        cwd: context.workspace,
        model: this.config.model,
        approvalPolicy: this.runtime.approvalPolicy
      })

      await turnDone
      await frameChain
    } catch (error: unknown) {
      this.logger.error('codex.turn_failed', {
        conversationKey,
        error: error instanceof Error ? error.message : String(error),
        turnId: observedTurnId
      })
      await this.publishUpdate(context, {
        kind: 'turn_finished',
        conversationKey,
        message: 'Turn failed'
      })
      child.kill('SIGTERM')
      return 'Sorry, I hit an error while processing that request.'
    } finally {
      child.stdin.end()
    }

    if (stderrLineBuffer.trim()) {
      this.logger.info('codex.stderr', { conversationKey, line: stderrLineBuffer.trim() })
    }

    if (stderrBuffer.trim()) {
      this.logger.info('codex.stderr_summary', {
        conversationKey,
        bytes: stderrBuffer.length
      })
    }

    const failed = turnFailed || (exitInfo?.signal != null)
    if (failed) {
      this.logger.error('codex.turn_failed', {
        conversationKey,
        exitCode: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? null,
        turnId: observedTurnId
      })
      await this.publishUpdate(context, {
        kind: 'turn_finished',
        conversationKey,
        message: 'Turn failed'
      })
      return 'Sorry, I hit an error while processing that request.'
    }

    if (observedThreadId) {
      await this.store.set(conversationKey, observedThreadId)
    }

    this.logger.info('codex.spawn_exit', {
      conversationKey,
      exitCode: exitInfo?.code ?? null,
      signal: exitInfo?.signal ?? null,
      heartbeatSeen
    })

    await this.publishUpdate(context, {
      kind: 'turn_finished',
      conversationKey,
      message: 'Turn finished'
    })

    return responseText || 'I completed processing but have no response to return.'
  }

  closeAll(): void {}

  async startNewSession(conversationKey: string): Promise<void> {
    await this.store.clear(conversationKey)
  }
}

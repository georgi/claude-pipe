export type JsonRpcId = number | string

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params: TParams
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: '2.0'
  method: string
  params: TParams
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: T
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: JsonRpcError
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure

export type CodexAskForApproval = 'untrusted' | 'on-failure' | 'on-request' | 'never'
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly' }
  | {
      type: 'workspaceWrite'
      writableRoots: string[]
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }

export interface CodexInitializeParams {
  clientInfo: { name: string; title: string | null; version: string }
  capabilities: { experimentalApi: boolean } | null
}

export interface CodexThreadStartParams {
  model?: string | null
  modelProvider?: string | null
  cwd?: string | null
  approvalPolicy?: CodexAskForApproval | null
  sandbox?: CodexSandboxMode | null
  baseInstructions?: string | null
  developerInstructions?: string | null
  ephemeral?: boolean | null
  experimentalRawEvents: boolean
}

export interface CodexThreadResumeParams {
  threadId: string
  model?: string | null
  modelProvider?: string | null
  cwd?: string | null
  approvalPolicy?: CodexAskForApproval | null
  sandbox?: CodexSandboxMode | null
  baseInstructions?: string | null
  developerInstructions?: string | null
}

export type CodexUserInput =
  | { type: 'text'; text: string; text_elements: Array<unknown> }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string }

export interface CodexTurnStartParams {
  threadId: string
  input: CodexUserInput[]
  cwd?: string | null
  approvalPolicy?: CodexAskForApproval | null
  sandboxPolicy?: CodexSandboxPolicy | null
  model?: string | null
}

export type CodexThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | {
      type: 'commandExecution'
      id: string
      command: string
      cwd: string
      status: string
      aggregatedOutput: string | null
      exitCode: number | null
    }
  | { type: 'fileChange'; id: string; status: string }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status: string }
  | { type: 'webSearch'; id: string; query: string }
  | { type: string; id: string; [key: string]: unknown }

export interface CodexThread {
  id: string
  cwd: string
}

export interface CodexTurn {
  id: string
  status: string
  error: { message: string } | null
}

export type CodexServerNotification =
  | { method: 'error'; params: { message?: string; [key: string]: unknown } }
  | { method: 'thread/started'; params: { thread: CodexThread } }
  | { method: 'turn/started'; params: { threadId: string; turn: CodexTurn } }
  | { method: 'turn/completed'; params: { threadId: string; turn: CodexTurn } }
  | { method: 'item/started'; params: { threadId: string; turnId: string; item: CodexThreadItem } }
  | { method: 'item/completed'; params: { threadId: string; turnId: string; item: CodexThreadItem } }
  | {
      method: 'item/agentMessage/delta'
      params: { threadId: string; turnId: string; itemId: string; delta: string }
    }
  | {
      method: 'item/commandExecution/outputDelta'
      params: { threadId: string; turnId: string; itemId: string; delta: string }
    }
  | { method: 'item/mcpToolCall/progress'; params: { threadId: string; turnId: string; itemId: string; message: string } }
  | { method: string; params: Record<string, unknown> }

export type CodexServerRequest =
  | {
      method: 'item/commandExecution/requestApproval'
      id: JsonRpcId
      params: { threadId: string; turnId: string; itemId: string; command?: string | null; cwd?: string | null }
    }
  | {
      method: 'item/fileChange/requestApproval'
      id: JsonRpcId
      params: { threadId: string; turnId: string; itemId: string; reason?: string | null }
    }
  | {
      method: 'item/tool/requestUserInput'
      id: JsonRpcId
      params: { threadId: string; turnId: string; itemId: string; questions: Array<{ id: string }> }
    }
  | {
      method: string
      id: JsonRpcId
      params: Record<string, unknown>
    }

export interface CodexThreadStartResponse {
  thread: CodexThread
}

export interface CodexThreadResumeResponse {
  thread: CodexThread
}

export interface CodexTurnStartResponse {
  turn: CodexTurn
}

/**
 * Mapping layer from Claude-style turn lifecycle to Codex App Server methods.
 */
export interface ClaudeToCodexRequestMap {
  createThread: {
    method: 'thread/start'
    params: CodexThreadStartParams
  }
  resumeThread: {
    method: 'thread/resume'
    params: CodexThreadResumeParams
  }
  startTurn: {
    method: 'turn/start'
    params: CodexTurnStartParams
  }
  sendMessage: {
    method: 'turn/start'
    params: CodexTurnStartParams
  }
  toolInvocationApproval: {
    method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval'
    response:
      | { decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' }
      | { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: unknown } } }
  }
  workspaceContextInjection: {
    method: 'turn/start'
    params: CodexTurnStartParams
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcSuccess | JsonRpcFailure {
  if (!isRecord(value)) return false
  if (!('id' in value)) return false
  return 'result' in value || 'error' in value
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  if (!isRecord(value)) return false
  return typeof value.method === 'string' && !('id' in value)
}

export function isJsonRpcServerRequest(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value)) return false
  return typeof value.method === 'string' && 'id' in value
}

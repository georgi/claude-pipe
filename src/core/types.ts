export type ChannelName = 'telegram' | 'discord'

/**
 * Normalized inbound message emitted by a channel adapter.
 */
export interface InboundMessage {
  channel: ChannelName
  senderId: string
  chatId: string
  content: string
  timestamp: string
  metadata?: Record<string, unknown>
}

/**
 * Normalized outbound message consumed by a channel adapter.
 */
export interface OutboundMessage {
  channel: ChannelName
  chatId: string
  content: string
  replyTo?: string
  metadata?: Record<string, unknown>
}

/**
 * Persistent mapping record from conversation key to Claude session ID.
 */
export interface SessionRecord {
  sessionId: string
  updatedAt: string
}

export type SessionMap = Record<string, SessionRecord>

/**
 * Per-turn execution context passed to tools.
 */
export interface ToolContext {
  workspace: string
  channel: ChannelName
  chatId: string
  onUpdate?: (event: AgentTurnUpdate) => Promise<void> | void
}

export type AgentTurnUpdateKind =
  | 'turn_started'
  | 'tool_call_started'
  | 'tool_call_finished'
  | 'tool_call_failed'
  | 'turn_finished'

export interface AgentTurnUpdate {
  kind: AgentTurnUpdateKind
  conversationKey: string
  message: string
  toolName?: string
  toolUseId?: string
}

/**
 * Minimal structured logger interface used across modules.
 */
export interface Logger {
  info(event: string, data?: Record<string, unknown>): void
  warn(event: string, data?: Record<string, unknown>): void
  error(event: string, data?: Record<string, unknown>): void
}

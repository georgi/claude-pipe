export type ChannelName = 'telegram' | 'discord' | 'cli'

/**
 * Media attachment metadata.
 */
export interface Attachment {
  type: 'image' | 'video' | 'audio' | 'document' | 'file'
  url?: string
  path?: string
  mimeType?: string
  size?: number
  filename?: string
}

/**
 * Normalized inbound message emitted by a channel adapter.
 */
export interface InboundMessage {
  channel: ChannelName
  senderId: string
  chatId: string
  content: string
  timestamp: string
  attachments?: Attachment[]
  metadata?: Record<string, unknown>
}

/**
 * A file to be sent alongside or instead of a text message.
 */
export interface FileAttachment {
  /** Absolute path to the file on disk. */
  filePath: string
  /** Optional caption shown with the file. */
  caption?: string
}

/**
 * A single inline keyboard button.
 */
export interface InlineButton {
  /** Button label text. */
  text: string
  /** Callback data sent back when pressed. */
  callbackData: string
}

/**
 * An inline keyboard: array of rows, each row an array of buttons.
 */
export type InlineKeyboard = InlineButton[][]

/**
 * Normalized outbound message consumed by a channel adapter.
 */
export interface OutboundMessage {
  channel: ChannelName
  chatId: string
  content: string
  metadata?: Record<string, unknown>
  attachments?: FileAttachment[]
  /** Optional inline keyboard to display below the message. */
  keyboard?: InlineKeyboard
}

/**
 * Opaque reference to a sent message, used for subsequent edits.
 */
export interface SentMessage {
  channel: ChannelName
  chatId: string
  messageId: string
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
  | 'text_streaming'
  | 'turn_finished'

export interface AgentTurnUpdate {
  kind: AgentTurnUpdateKind
  conversationKey: string
  message: string
  toolName?: string
  toolUseId?: string
  /** Partial accumulated response text, present when kind is 'text_streaming'. */
  text?: string
}

/**
 * Minimal structured logger interface used across modules.
 */
export interface Logger {
  info(event: string, data?: Record<string, unknown>): void
  warn(event: string, data?: Record<string, unknown>): void
  error(event: string, data?: Record<string, unknown>): void
}

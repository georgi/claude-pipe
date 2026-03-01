import type { InboundMessage, OutboundMessage, SentMessage } from '../core/types.js'

/**
 * Common channel adapter contract.
 */
export interface Channel {
  readonly name: InboundMessage['channel']
  start(): Promise<void>
  stop(): Promise<void>
  send(message: OutboundMessage): Promise<SentMessage | void>
  editMessage(sent: SentMessage, newContent: string): Promise<void>
}

/**
 * Shared helper for allow-list decisions.
 */
export function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.length === 0) return true
  return allowFrom.includes(senderId)
}

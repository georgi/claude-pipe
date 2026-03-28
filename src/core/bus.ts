import type { InboundMessage, OutboundMessage } from './types.js'

/** Callback invoked whenever an outbound message is published. */
export type OutboundListener = (msg: OutboundMessage) => void

/**
 * Minimal async message bus.
 *
 * Keeps channel adapters and the agent loop decoupled through inbound/outbound queues.
 */
export class MessageBus {
  private inboundQueue: InboundMessage[] = []
  private outboundQueue: OutboundMessage[] = []
  private inboundWaiters: Array<(msg: InboundMessage) => void> = []
  private outboundWaiters: Array<(msg: OutboundMessage) => void> = []
  private outboundListeners: OutboundListener[] = []

  /** Publishes an inbound message to the agent loop. */
  async publishInbound(msg: InboundMessage): Promise<void> {
    const waiter = this.inboundWaiters.shift()
    if (waiter) {
      waiter(msg)
      return
    }
    this.inboundQueue.push(msg)
  }

  /** Waits for and returns the next inbound message. */
  async consumeInbound(): Promise<InboundMessage> {
    const existing = this.inboundQueue.shift()
    if (existing) return existing
    return new Promise<InboundMessage>((resolve) => this.inboundWaiters.push(resolve))
  }

  /** Publishes an outbound message for channel delivery. */
  async publishOutbound(msg: OutboundMessage): Promise<void> {
    for (const listener of this.outboundListeners) {
      listener(msg)
    }

    const waiter = this.outboundWaiters.shift()
    if (waiter) {
      waiter(msg)
      return
    }
    this.outboundQueue.push(msg)
  }

  /** Waits for and returns the next outbound message. */
  async consumeOutbound(): Promise<OutboundMessage> {
    const existing = this.outboundQueue.shift()
    if (existing) return existing
    return new Promise<OutboundMessage>((resolve) => this.outboundWaiters.push(resolve))
  }

  /** Registers a listener that is called for every outbound message. */
  onOutbound(listener: OutboundListener): void {
    this.outboundListeners.push(listener)
  }
}

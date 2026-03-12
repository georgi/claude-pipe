import type { ToolContext } from './types.js'

export interface ActiveTurnInfo {
  conversationKey: string
  prompt: string
}

/**
 * Shared LLM runtime contract used by the agent loop and slash commands.
 */
export interface ModelClient {
  runTurn(conversationKey: string, userText: string, context: ToolContext): Promise<string>
  cancelTurn(conversationKey: string): void
  closeAll(): void
  startNewSession(conversationKey: string): Promise<void>
  getActiveTurns(): ActiveTurnInfo[]
}

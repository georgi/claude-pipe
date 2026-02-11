import type { ToolContext } from './types.js'

/**
 * Shared LLM runtime contract used by the agent loop and slash commands.
 */
export interface ModelClient {
  runTurn(conversationKey: string, userText: string, context: ToolContext): Promise<string>
  closeAll(): void
  startNewSession(conversationKey: string): Promise<void>
}

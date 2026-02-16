import type { Attachment, ToolContext } from './types.js'

/**
 * Shared LLM runtime contract used by the agent loop and slash commands.
 * 
 * The agent interface defines how channels communicate with LLM runtimes.
 * For media attachments:
 * - Images and media are passed via the optional `attachments` parameter
 * - The implementation should describe attachments to the LLM (e.g., "[User sent an image: filename.jpg]")
 * - For vision-capable models, implementations may pass image data directly to the LLM
 * - File paths in attachments are relative to the workspace or absolute temp paths
 */
export interface ModelClient {
  runTurn(
    conversationKey: string,
    userText: string,
    context: ToolContext,
    attachments?: Attachment[]
  ): Promise<string>
  closeAll(): void
  startNewSession(conversationKey: string): Promise<void>
}

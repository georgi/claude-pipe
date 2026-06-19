import type { ToolContext } from './types.js'

/**
 * Shared LLM runtime contract used by the agent loop and slash commands.
 *
 * Every agent harness (Pi, Claude, …) implements this interface, so the rest
 * of the app — the agent loop, command handlers, channels — is agnostic to
 * which SDK is actually driving the conversation. Selection happens once, in
 * {@link createModelClient}, based on `config.harness`.
 */
export interface ModelClient {
  /** Runs a single conversational turn and returns the assistant's text. */
  runTurn(conversationKey: string, userText: string, context: ToolContext): Promise<string>
  /** Aborts an in-flight turn for the given conversation, if any. */
  cancelTurn(conversationKey: string): void
  /** Tears down every live session (used on shutdown). */
  closeAll(): void
  /** Forgets the conversation's session so the next turn starts fresh. */
  startNewSession(conversationKey: string): Promise<void>
  /**
   * Switches the active model for subsequent turns. Validation is
   * implementation-dependent: the Pi harness resolves the model against its
   * registry and throws on an unknown model (leaving prior state intact),
   * while the Claude harness accepts any string and defers errors to the next
   * `query()` call (the SDK rejects unknown models at request time).
   */
  setModel(modelString: string): void
}

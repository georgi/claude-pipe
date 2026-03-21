import type { ClaudePipeConfig } from '../config/schema.js'
import { ClaudeClient } from './claude-client.js'
import type { Logger } from './types.js'
import type { ModelClient } from './model-client.js'
import { SessionStore } from './session-store.js'

export function createModelClient(
  config: ClaudePipeConfig,
  store: SessionStore,
  logger: Logger
): ModelClient {
  return new ClaudeClient(config, store, logger)
}

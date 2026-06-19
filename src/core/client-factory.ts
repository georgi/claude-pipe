import type { PiPipeConfig } from '../config/schema.js'
import { ClaudeClient } from './claude-client.js'
import { PiClient } from './pi-client.js'
import type { Logger } from './types.js'
import type { ModelClient } from './model-client.js'
import { SessionStore } from './session-store.js'

/**
 * Builds the {@link ModelClient} for the configured agent harness.
 *
 * This is the single place that knows about concrete harness implementations;
 * everything downstream depends only on the {@link ModelClient} interface.
 */
export function createModelClient(
  config: PiPipeConfig,
  store: SessionStore,
  logger: Logger
): ModelClient {
  switch (config.harness) {
    case 'claude':
      return new ClaudeClient(config, store, logger)
    case 'pi':
    default:
      return new PiClient(config, store, logger)
  }
}

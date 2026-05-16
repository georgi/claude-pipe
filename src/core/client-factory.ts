import type { PiPipeConfig } from '../config/schema.js'
import { PiClient } from './pi-client.js'
import type { Logger } from './types.js'
import type { ModelClient } from './model-client.js'
import { SessionStore } from './session-store.js'

export function createModelClient(
  config: PiPipeConfig,
  store: SessionStore,
  logger: Logger
): ModelClient {
  return new PiClient(config, store, logger)
}

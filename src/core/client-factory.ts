import type { ClaudePipeConfig } from '../config/schema.js'
import { ClaudeClient } from './claude-client.js'
import { CodexClient } from './codex-client.js'
import type { Logger } from './types.js'
import type { ModelClient } from './model-client.js'
import { SessionStore } from './session-store.js'

export function resolveProvider(): 'claude' | 'codex' {
  const provider = process.env.CLAUDEPIPE_LLM_PROVIDER?.trim().toLowerCase()
  return provider === 'codex' ? 'codex' : 'claude'
}

export function resolveProviderFromConfig(config: ClaudePipeConfig): 'claude' | 'codex' {
  if (config.llmProvider === 'codex' || config.llmProvider === 'claude') {
    return config.llmProvider
  }
  return resolveProvider()
}

export function createModelClient(
  config: ClaudePipeConfig,
  store: SessionStore,
  logger: Logger
): ModelClient {
  const provider = resolveProviderFromConfig(config)
  if (provider === 'codex') {
    return new CodexClient(config, store, logger)
  }
  return new ClaudeClient(config, store, logger)
}

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Guardrail } from './guardrail.js'

/**
 * Pi extension that enforces the shared {@link Guardrail} policy: it blocks
 * filesystem-mutating / command-execution tools and reads of sensitive paths.
 *
 * Registered by {@link PiClient} only when sandbox mode is enabled, so a
 * normal personal-assistant deployment keeps Pi's full tool set.
 */
export function createGuardrailExtension(guardrail: Guardrail = new Guardrail()) {
  return (pi: ExtensionAPI): void => {
    pi.on('tool_call', (event) => {
      const toolName = event.toolName ?? ''
      const input = (event as { input?: Record<string, unknown> }).input ?? {}
      const decision = guardrail.evaluate(toolName, input)
      if (decision.blocked) {
        return {
          block: true,
          content: decision.reason,
          isError: true
        }
      }
      return undefined
    })
  }
}

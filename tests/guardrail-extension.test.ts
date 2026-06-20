import { describe, it, expect } from 'vitest'
import { createGuardrailExtension } from '../src/core/guardrail-extension.js'
import { Guardrail } from '../src/core/guardrail.js'

type ToolCallResult = { block: boolean; content?: string; isError?: boolean } | undefined

/** Registers the extension on a fake ExtensionAPI and returns the tool_call handler. */
function captureHandler(): (event: unknown) => ToolCallResult {
  const guardrail = new Guardrail({ homeDir: '/home/tester' })
  let handler: ((event: unknown) => ToolCallResult) | undefined
  const pi = {
    on: (event: string, h: (event: unknown) => ToolCallResult) => {
      if (event === 'tool_call') handler = h
    }
  }
  createGuardrailExtension(guardrail)(pi as never)
  if (!handler) throw new Error('handler not registered')
  return handler
}

describe('createGuardrailExtension', () => {
  it('blocks dangerous tools with an error result', () => {
    const handler = captureHandler()
    const result = handler({ toolName: 'bash', input: { command: 'ls' } })
    expect(result).toMatchObject({ block: true, isError: true })
    expect(result?.content).toContain('sandbox')
  })

  it('blocks reads of sensitive paths', () => {
    const handler = captureHandler()
    const result = handler({ toolName: 'read', input: { path: '/home/tester/.ssh/id_rsa' } })
    expect(result?.block).toBe(true)
  })

  it('allows benign tool calls (returns undefined)', () => {
    const handler = captureHandler()
    expect(
      handler({ toolName: 'read', input: { path: '/home/tester/work/a.txt' } })
    ).toBeUndefined()
  })

  it('tolerates events with no toolName or input', () => {
    const handler = captureHandler()
    expect(handler({})).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'

import { applySummaryTemplate } from '../src/core/prompt-template.js'

describe('applySummaryTemplate', () => {
  it('keeps non-summary prompts unchanged', () => {
    const result = applySummaryTemplate('hello bot', {
      enabled: true,
      template:
        'Workspace: {{workspace}}\nRequest: {{request}}\nReturn concise bullet summary with file references.'
    }, '/tmp/ws')

    expect(result).toBe('hello bot')
  })

  it('applies template to summary-like prompts', () => {
    const result = applySummaryTemplate('summarize files in workspace', {
      enabled: true,
      template:
        'Workspace: {{workspace}}\nRequest: {{request}}\nReturn concise bullet summary with file references.'
    }, '/tmp/ws')

    expect(result).toContain('Workspace: /tmp/ws')
    expect(result).toContain('Request: summarize files in workspace')
    expect(result).toContain('file references')
  })

  it('does not apply template when disabled', () => {
    const input = 'summarize files in workspace'
    const result = applySummaryTemplate(input, {
      enabled: false,
      template: 'Workspace: {{workspace}}\nRequest: {{request}}'
    }, '/tmp/ws')

    expect(result).toBe(input)
  })
})

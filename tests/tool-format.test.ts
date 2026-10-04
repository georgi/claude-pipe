import { describe, expect, it } from 'vitest'

import { formatToolLine, formatToolName, summarizeToolInput } from '../src/core/tool-format.js'

describe('formatToolName', () => {
  it('strips the mcp prefix and underscores', () => {
    expect(formatToolName('mcp__github__create_pull_request')).toBe('create pull request')
    expect(formatToolName('Bash')).toBe('Bash')
  })
})

describe('summarizeToolInput', () => {
  it('shows the shell command for Bash', () => {
    expect(summarizeToolInput('Bash', { command: 'npm test', description: 'Run tests' })).toBe(
      'npm test'
    )
  })

  it('falls back to the description when Bash has no command', () => {
    expect(summarizeToolInput('Bash', { description: 'Run tests' })).toBe('Run tests')
  })

  it('shortens file paths for file tools', () => {
    expect(
      summarizeToolInput('Read', { file_path: '/home/user/proj/src/core/agent-loop.ts' })
    ).toBe('core/agent-loop.ts')
    expect(summarizeToolInput('Edit', { file_path: 'src/index.ts' })).toBe('src/index.ts')
  })

  it('combines pattern and path for Grep', () => {
    expect(summarizeToolInput('Grep', { pattern: 'todo', path: 'src/core' })).toBe(
      'todo in src/core'
    )
  })

  it('uses the query for web tools', () => {
    expect(summarizeToolInput('WebSearch', { query: 'claude pipe' })).toBe('claude pipe')
    expect(summarizeToolInput('WebFetch', { url: 'https://example.com' })).toBe(
      'https://example.com'
    )
  })

  it('uses the description for sub-agent tasks', () => {
    expect(summarizeToolInput('Task', { description: 'Find flaky tests', prompt: 'long...' })).toBe(
      'Find flaky tests'
    )
  })

  it('falls back to the first meaningful argument for unknown tools', () => {
    expect(summarizeToolInput('mcp__github__issue_read', { issue_number: 12 })).toBe('12')
  })

  it('collapses whitespace and truncates long details', () => {
    const detail = summarizeToolInput('Bash', { command: `echo   a\nb${'x'.repeat(300)}` })
    expect(detail.length).toBeLessThanOrEqual(120)
    expect(detail).toContain('echo a b')
    expect(detail.endsWith('…')).toBe(true)
  })

  it('returns an empty string when there is nothing to show', () => {
    expect(summarizeToolInput('Bash', {})).toBe('')
    expect(summarizeToolInput('Bash', undefined)).toBe('')
  })
})

describe('formatToolLine', () => {
  it('renders status, name, and detail', () => {
    expect(formatToolLine('running', 'Bash', 'npm test')).toBe('🔧 Bash: npm test')
    expect(formatToolLine('done', 'Bash', 'npm test')).toBe('✅ Bash: npm test')
    expect(formatToolLine('failed', 'Bash', 'npm test')).toBe('❌ Bash: npm test')
  })

  it('omits the separator when there is no detail', () => {
    expect(formatToolLine('done', 'WebSearch')).toBe('✅ WebSearch')
    expect(formatToolLine('done', 'WebSearch', '  ')).toBe('✅ WebSearch')
  })
})

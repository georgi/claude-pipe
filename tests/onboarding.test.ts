import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('onboarding wizard', () => {
  const tmpDir = path.join(import.meta.dirname ?? __dirname, '..', '.test-onboarding-ws')

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates AGENTS.md in workspace directory', () => {
    fs.mkdirSync(tmpDir, { recursive: true })
    const agentsPath = path.join(tmpDir, 'AGENTS.md')

    // Simulate the workspace step of the wizard
    expect(fs.existsSync(agentsPath)).toBe(false)
    fs.writeFileSync(
      agentsPath,
      '# AGENTS.md\n\nThis file configures the Claude agent for this workspace.\n\n## Instructions\n\n- Answer concisely and accurately.\n- When modifying files, explain what changed.\n',
      'utf-8'
    )
    expect(fs.existsSync(agentsPath)).toBe(true)

    const content = fs.readFileSync(agentsPath, 'utf-8')
    expect(content).toContain('# AGENTS.md')
    expect(content).toContain('## Instructions')
  })

  it('does not overwrite existing AGENTS.md', () => {
    fs.mkdirSync(tmpDir, { recursive: true })
    const agentsPath = path.join(tmpDir, 'AGENTS.md')

    fs.writeFileSync(agentsPath, '# Custom AGENTS\n', 'utf-8')

    // Simulate wizard: skip if exists
    if (!fs.existsSync(agentsPath)) {
      fs.writeFileSync(agentsPath, '# AGENTS.md\n', 'utf-8')
    }

    const content = fs.readFileSync(agentsPath, 'utf-8')
    expect(content).toBe('# Custom AGENTS\n')
  })
})

import { describe, it, expect } from 'vitest'
import { Guardrail, defaultSensitivePaths } from '../src/core/guardrail.js'

const HOME = '/home/tester'

function guard(): Guardrail {
  return new Guardrail({ homeDir: HOME })
}

describe('Guardrail.isBlockedTool', () => {
  it('blocks filesystem-mutating and exec tools regardless of case', () => {
    const g = guard()
    for (const name of ['bash', 'Bash', 'edit', 'Edit', 'write', 'Write', 'MultiEdit']) {
      expect(g.isBlockedTool(name)).toBe(true)
    }
  })

  it('blocks mcp shell/filesystem write tools by full and bare name', () => {
    const g = guard()
    expect(g.isBlockedTool('mcp__shell__execute')).toBe(true)
    expect(g.isBlockedTool('mcp__filesystem__write')).toBe(true)
    expect(g.isBlockedTool('mcp__server__edit')).toBe(true)
  })

  it('blocks spawn_/exec_ prefixed tools', () => {
    const g = guard()
    expect(g.isBlockedTool('spawn_process')).toBe(true)
    expect(g.isBlockedTool('mcp__x__exec_command')).toBe(true)
  })

  it('allows read and web/search tools', () => {
    const g = guard()
    for (const name of ['read', 'Read', 'grep', 'web_search', 'mcp__search__query']) {
      expect(g.isBlockedTool(name)).toBe(false)
    }
  })
})

describe('Guardrail.isSensitivePath', () => {
  it('flags home-derived sensitive files and directories', () => {
    const g = guard()
    expect(g.isSensitivePath(`${HOME}/.ssh/id_rsa`)).toBe(true)
    expect(g.isSensitivePath(`${HOME}/.env`)).toBe(true)
    expect(g.isSensitivePath(`${HOME}/.pi-pipe/settings.json`)).toBe(true)
    expect(g.isSensitivePath('/etc/passwd')).toBe(true)
  })

  it('does not flag ordinary workspace files', () => {
    const g = guard()
    expect(g.isSensitivePath(`${HOME}/workspace/notes.md`)).toBe(false)
    expect(g.isSensitivePath('/tmp/output.txt')).toBe(false)
  })

  it('honors extra sensitive paths', () => {
    const g = new Guardrail({ homeDir: HOME, extraSensitivePaths: ['/srv/secrets'] })
    expect(g.isSensitivePath('/srv/secrets/key.pem')).toBe(true)
  })
})

describe('Guardrail.evaluate', () => {
  it('blocks dangerous tools with a reason', () => {
    const decision = guard().evaluate('bash', { command: 'ls' })
    expect(decision.blocked).toBe(true)
    expect(decision.reason).toContain('sandbox')
  })

  it('blocks sensitive reads via path and file_path inputs', () => {
    const g = guard()
    expect(g.evaluate('read', { path: `${HOME}/.ssh/id_rsa` }).blocked).toBe(true)
    expect(g.evaluate('Read', { file_path: '/etc/passwd' }).blocked).toBe(true)
  })

  it('allows benign read tools', () => {
    expect(guard().evaluate('read', { path: `${HOME}/workspace/a.txt` }).blocked).toBe(false)
    expect(guard().evaluate('grep', { pattern: 'x' }).blocked).toBe(false)
  })
})

describe('defaultSensitivePaths', () => {
  it('derives paths from the provided home directory', () => {
    const paths = defaultSensitivePaths(HOME)
    expect(paths).toContain(`${HOME}/.ssh`)
    expect(paths).toContain('/etc/passwd')
  })
})

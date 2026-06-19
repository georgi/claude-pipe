import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const BLOCKED_TOOLS = new Set([
  'bash',
  'edit',
  'write',
  'mcp__shell__execute',
  'mcp__filesystem__write',
  'mcp__filesystem__edit'
])

const BLOCKED_PREFIXES = ['spawn_', 'exec_']

const SENSITIVE_PATHS = [
  '/home/claude/.env',
  '/home/claude/.pi-pipe',
  '/home/claude/.pi',
  '/home/claude/.ssh',
  '/home/claude/.aws',
  '/home/claude/.npmrc',
  '/etc/shadow',
  '/etc/passwd',
  '/var/lib/task-orchestrator',
  '/home/claude/webhook',
  '/home/claude/webhook/secret'
]

function isBlocked(toolName: string): boolean {
  const bare = toolName.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')
  if (BLOCKED_TOOLS.has(bare)) return true
  if (BLOCKED_TOOLS.has(toolName)) return true
  for (const prefix of BLOCKED_PREFIXES) {
    if (bare.startsWith(prefix) || toolName.startsWith(prefix)) return true
  }
  return false
}

function isSensitivePath(path: string): boolean {
  const normalized = path.replace(/\/+$/, '')
  for (const sensitive of SENSITIVE_PATHS) {
    if (normalized === sensitive || normalized.startsWith(sensitive + '/')) return true
  }
  return false
}

/**
 * Pi extension that blocks dangerous tools and sensitive file reads.
 */
export function createGuardrailExtension() {
  return (pi: ExtensionAPI): void => {
    pi.on('tool_call', (event) => {
      const toolName = event.toolName ?? ''

      // Block dangerous tools outright
      if (isBlocked(toolName)) {
        return {
          block: true,
          content:
            `Tool "${toolName}" is not available in this public sandbox. ` +
            'I can read files (except sensitive areas), search the web, and use safe MCP tools.',
          isError: true
        }
      }

      // Block reads of sensitive paths
      if (toolName === 'read') {
        const path = (event as { input?: { path?: string } }).input?.path ?? ''
        if (path && isSensitivePath(path)) {
          return {
            block: true,
            content: `Cannot read "${path}" — this path is restricted in the public sandbox.`,
            isError: true
          }
        }
      }

      // Block MCP filesystem reads of sensitive paths
      if (toolName.startsWith('mcp__')) {
        const input = (event as { input?: Record<string, unknown> }).input ?? {}
        const path = typeof input.path === 'string' ? input.path : ''
        if (path && isSensitivePath(path)) {
          return {
            block: true,
            content: `Cannot access "${path}" — this path is restricted in the public sandbox.`,
            isError: true
          }
        }
      }

      return undefined
    })
  }
}

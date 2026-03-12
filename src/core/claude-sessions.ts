import { readdir, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export interface ClaudeSessionSummary {
  sessionId: string
  firstMessage: string
  model: string
  lastActive: string
  gitBranch: string
  userMessageCount: number
  assistantMessageCount: number
}

export interface ClaudeSessionService {
  list(workspace: string): Promise<ClaudeSessionSummary[]>
  get(workspace: string, sessionIdOrPrefix: string): Promise<ClaudeSessionSummary | undefined>
  resolve(workspace: string, prefix: string): Promise<{ id: string } | { error: string }>
  delete(workspace: string, sessionId: string): Promise<void>
}

function encodeWorkspacePath(workspace: string): string {
  return path.resolve(workspace).replace(/[/.]/g, '-')
}

function getClaudeProjectDir(workspace: string): string {
  return path.join(homedir(), '.claude', 'projects', encodeWorkspacePath(workspace))
}

function hasTextContent(content: unknown): boolean {
  if (typeof content === 'string' && content.length > 0) return true
  if (Array.isArray(content)) {
    return content.some(
      (b) =>
        (typeof b === 'string' && b.length > 0) ||
        (b !== null && typeof b === 'object' && (b as Record<string, unknown>).type === 'text' &&
          typeof (b as Record<string, unknown>).text === 'string' &&
          ((b as Record<string, unknown>).text as string).length > 0)
    )
  }
  return false
}

function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === 'string' && content.length > 0) return content.slice(0, 80)
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string' && block.length > 0) return block.slice(0, 80)
      if (
        block !== null && typeof block === 'object' &&
        block.type === 'text' && typeof block.text === 'string' && block.text.length > 0
      ) {
        return (block.text as string).slice(0, 80)
      }
    }
  }
  return undefined
}

function extractFirstUserMessage(lines: string[]): string {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.type !== 'user') continue
      const text = extractTextFromContent(obj.message?.content)
      if (text) return text
    } catch {
      // skip malformed lines
    }
  }
  return '(no message)'
}

function parseSession(sessionId: string, raw: string): ClaudeSessionSummary {
  const lines = raw.split('\n').filter(Boolean)
  let model = ''
  let lastActiveMs = 0
  let lastActive = ''
  let gitBranch = ''
  let userMessageCount = 0
  let assistantMessageCount = 0

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      const ts = obj.timestamp as string | undefined
      if (ts) {
        const t = Date.parse(ts)
        if (!isNaN(t) && t > lastActiveMs) {
          lastActiveMs = t
          lastActive = ts
        }
      }

      if (obj.type === 'user') {
        if (hasTextContent(obj.message?.content)) {
          userMessageCount++
        }
        if (obj.gitBranch) gitBranch = obj.gitBranch
      } else if (obj.type === 'assistant') {
        assistantMessageCount++
        const m = obj.message?.model as string | undefined
        if (m) model = m
      }
    } catch {
      // skip malformed lines
    }
  }

  return {
    sessionId,
    firstMessage: extractFirstUserMessage(lines),
    model,
    lastActive,
    gitBranch,
    userMessageCount,
    assistantMessageCount
  }
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name)
}

async function resolveSessionId(workspace: string, prefix: string): Promise<{ id: string } | { error: string }> {
  const dir = getClaudeProjectDir(workspace)
  let files: string[]
  try {
    files = await listJsonlFiles(dir)
  } catch {
    return { error: 'No sessions found for this workspace.' }
  }
  const ids = files.map((f) => f.replace(/\.jsonl$/, ''))
  const exact = ids.find((id) => id === prefix)
  if (exact) return { id: exact }
  const matches = ids.filter((id) => id.startsWith(prefix))
  if (matches.length === 1) return { id: matches[0]! }
  if (matches.length === 0) return { error: `No session matching "${prefix}".` }
  return {
    error: `Ambiguous prefix "${prefix}", matches: ${matches.map((m) => m.slice(0, 8)).join(', ')}`
  }
}

export function createClaudeSessionService(): ClaudeSessionService {
  return {
    async list(workspace: string): Promise<ClaudeSessionSummary[]> {
      const dir = getClaudeProjectDir(workspace)
      let files: string[]
      try {
        files = await listJsonlFiles(dir)
      } catch {
        return []
      }
      const sessions: ClaudeSessionSummary[] = []

      for (const file of files) {
        try {
          const raw = await readFile(path.join(dir, file), 'utf-8')
          const sessionId = file.replace(/\.jsonl$/, '')
          sessions.push(parseSession(sessionId, raw))
        } catch {
          // skip unreadable files
        }
      }

      sessions.sort((a, b) => {
        if (b.lastActive > a.lastActive) return 1
        if (b.lastActive < a.lastActive) return -1
        return 0
      })
      return sessions
    },

    async get(workspace: string, sessionIdOrPrefix: string): Promise<ClaudeSessionSummary | undefined> {
      const result = await resolveSessionId(workspace, sessionIdOrPrefix)
      if ('error' in result) return undefined
      const dir = getClaudeProjectDir(workspace)
      try {
        const raw = await readFile(path.join(dir, `${result.id}.jsonl`), 'utf-8')
        return parseSession(result.id, raw)
      } catch {
        return undefined
      }
    },

    resolve: resolveSessionId,

    async delete(workspace: string, sessionId: string): Promise<void> {
      const dir = getClaudeProjectDir(workspace)
      const filePath = path.join(dir, `${sessionId}.jsonl`)
      try {
        await unlink(filePath)
      } catch {
        // File may already be gone
      }
    }
  }
}

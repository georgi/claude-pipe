/**
 * Helpers for rendering tool-call activity as short, informative chat lines.
 *
 * Chat channels only show a single status message per turn, so each line has to
 * carry enough context ("Bash: npm test" rather than just "Bash") to be useful.
 */

/** Maximum length of the detail suffix appended after the tool name. */
const MAX_DETAIL = 120

/**
 * Converts a raw tool name into a human-readable label safe for Telegram Markdown.
 * MCP tools arrive as mcp__ServerName__tool_name — strip the prefix and
 * replace underscores so Telegram does not interpret __x__ as bold formatting.
 */
export function formatToolName(name: string): string {
  const mcpMatch = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name)
  const bare = mcpMatch?.[1] ?? name
  return bare.replace(/_/g, ' ')
}

/** Collapses whitespace and truncates to keep status lines single-line and short. */
export function condense(value: string, max = MAX_DETAIL): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

/** Shortens a path to its last two segments so long absolute paths stay readable. */
export function shortPath(value: string): string {
  const parts = value.split('/').filter(Boolean)
  if (parts.length <= 2) return value
  return parts.slice(-2).join('/')
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/**
 * Picks the most informative argument for a tool call and renders it as a short
 * detail string — the shell command for Bash, the file for Read/Edit/Write, the
 * pattern for Grep, the URL for WebFetch, and so on.
 *
 * Falls back to the first meaningful string argument for unknown tools (including
 * MCP tools), and returns an empty string when nothing useful is available.
 */
export function summarizeToolInput(toolName: string, input: unknown): string {
  if (input == null || typeof input !== 'object') return ''
  const args = input as Record<string, unknown>
  const bare = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(toolName)?.[1] ?? toolName
  const key = bare.toLowerCase()

  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = asString(args[name])
      if (value) return value
    }
    return undefined
  }

  if (key === 'bash' || key === 'shell' || key === 'run_command') {
    const command = pick('command', 'cmd', 'script')
    if (command) return condense(command)
    return condense(pick('description') ?? '')
  }

  if (key === 'read' || key === 'write' || key === 'edit' || key === 'notebookedit') {
    const file = pick('file_path', 'filePath', 'path', 'notebook_path')
    if (file) return shortPath(file)
  }

  if (key === 'grep' || key === 'search') {
    const pattern = pick('pattern', 'query')
    const path = pick('path', 'glob')
    if (pattern && path) return condense(`${pattern} in ${shortPath(path)}`)
    if (pattern) return condense(pattern)
  }

  if (key === 'glob' || key === 'ls' || key === 'list') {
    const pattern = pick('pattern', 'path')
    if (pattern) return condense(pattern)
  }

  if (key === 'task' || key === 'agent') {
    const description = pick('description', 'subagent_type', 'prompt')
    if (description) return condense(description, 80)
  }

  if (key === 'webfetch' || key === 'fetch') {
    const url = pick('url')
    if (url) return condense(url)
  }

  if (key === 'websearch') {
    const query = pick('query')
    if (query) return condense(query)
  }

  if (key === 'todowrite') {
    const todos = args.todos
    if (Array.isArray(todos)) {
      const active = todos.find(
        (t) =>
          typeof t === 'object' && t !== null && (t as { status?: string }).status !== 'completed'
      ) as { content?: string; activeForm?: string } | undefined
      const label = active?.activeForm ?? active?.content
      if (label) return condense(label, 80)
      return `${todos.length} task${todos.length === 1 ? '' : 's'}`
    }
  }

  // Unknown / MCP tools: fall back to the first meaningful string argument.
  const preferred = pick('description', 'query', 'prompt', 'name', 'path', 'url', 'command')
  if (preferred) return condense(preferred, 80)

  for (const value of Object.values(args)) {
    const str = asString(value)
    if (str) return condense(str, 80)
  }

  return ''
}

/** Status marker for a tool call's lifecycle stage. */
export type ToolCallStatus = 'running' | 'done' | 'failed'

const STATUS_ICON: Record<ToolCallStatus, string> = {
  running: '🔧',
  done: '✅',
  failed: '❌'
}

/**
 * Renders one tool call as a single status line: icon, tool name, and the
 * detail extracted from the tool's arguments when there is one.
 */
export function formatToolLine(status: ToolCallStatus, toolName: string, detail?: string): string {
  const label = formatToolName(toolName)
  const trimmed = detail?.trim()
  return trimmed ? `${STATUS_ICON[status]} ${label}: ${trimmed}` : `${STATUS_ICON[status]} ${label}`
}

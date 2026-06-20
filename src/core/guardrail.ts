import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Tools that mutate the filesystem or execute commands. Matched
 * case-insensitively against both the full tool name and the bare name
 * (with any `mcp__server__` prefix stripped), so the same set covers Pi
 * (`bash`, `edit`, `write`) and Claude (`Bash`, `Edit`, `Write`).
 */
const DANGEROUS_TOOLS = new Set([
  'bash',
  'edit',
  'multiedit',
  'write',
  'notebookedit',
  'mcp__shell__execute',
  'mcp__filesystem__write',
  'mcp__filesystem__edit'
])

/** Bare-name prefixes that indicate process spawning / execution. */
const DANGEROUS_PREFIXES = ['spawn_', 'exec_']

/** Input keys different harnesses use to carry a filesystem path. */
const PATH_KEYS = ['path', 'file_path', 'filepath', 'filePath']

function stripMcpPrefix(toolName: string): string {
  return toolName.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')
}

export interface GuardrailDecision {
  blocked: boolean
  reason?: string
}

export interface GuardrailOptions {
  /** Extra absolute paths to treat as sensitive. */
  extraSensitivePaths?: string[]
  /** Overrides the home directory used to derive per-user sensitive paths. */
  homeDir?: string
}

/**
 * Default sensitive paths derived from the user's home directory plus a couple
 * of well-known system files. Deriving from `os.homedir()` keeps the list
 * meaningful regardless of which account or platform the bot runs on.
 */
export function defaultSensitivePaths(homeDir: string = os.homedir()): string[] {
  const home = (rel: string): string => path.join(homeDir, rel)
  return [
    home('.env'),
    home('.ssh'),
    home('.aws'),
    home('.npmrc'),
    home('.pi-pipe'),
    home('.pi'),
    home('.config/gh'),
    '/etc/shadow',
    '/etc/passwd'
  ]
}

/**
 * Tool-call guardrail shared by the Pi and Claude harnesses.
 *
 * Blocks filesystem-mutating / command-execution tools and reads of sensitive
 * paths. The Pi harness consults it from a `tool_call` extension hook; the
 * Claude harness consults it from the `canUseTool` callback — so both enforce
 * the same policy when sandbox mode is enabled.
 */
export class Guardrail {
  private readonly sensitivePaths: string[]

  constructor(options: GuardrailOptions = {}) {
    this.sensitivePaths = [
      ...defaultSensitivePaths(options.homeDir),
      ...(options.extraSensitivePaths ?? [])
    ].map((p) => path.resolve(p).replace(/\/+$/, ''))
  }

  /** True when the tool can mutate the filesystem or run commands. */
  isBlockedTool(toolName: string): boolean {
    const lower = toolName.toLowerCase()
    const bare = stripMcpPrefix(toolName).toLowerCase()
    if (DANGEROUS_TOOLS.has(bare) || DANGEROUS_TOOLS.has(lower)) return true
    return DANGEROUS_PREFIXES.some((prefix) => bare.startsWith(prefix) || lower.startsWith(prefix))
  }

  /** True when `target` resolves to (or under) a sensitive path. */
  isSensitivePath(target: string): boolean {
    const normalized = path.resolve(target).replace(/\/+$/, '')
    return this.sensitivePaths.some(
      (sensitive) => normalized === sensitive || normalized.startsWith(sensitive + path.sep)
    )
  }

  private extractPath(input: Record<string, unknown>): string | undefined {
    for (const key of PATH_KEYS) {
      const value = input[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return undefined
  }

  /** Evaluates a single tool call against the policy. */
  evaluate(toolName: string, input: Record<string, unknown> = {}): GuardrailDecision {
    if (this.isBlockedTool(toolName)) {
      return {
        blocked: true,
        reason:
          `Tool "${toolName}" is disabled in sandbox mode. ` +
          'I can read files (outside sensitive areas), search the web, and use safe tools.'
      }
    }
    const target = this.extractPath(input)
    if (target && this.isSensitivePath(target)) {
      return { blocked: true, reason: `Access to "${target}" is restricted in sandbox mode.` }
    }
    return { blocked: false }
  }
}

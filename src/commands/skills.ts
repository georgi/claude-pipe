import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/**
 * Discovered skill metadata from SKILL.md frontmatter.
 */
export interface SkillInfo {
  name: string
  description: string
  argumentHint?: string
}

/**
 * Scans ~/.claude/skills/ for user-invocable skills by reading SKILL.md frontmatter.
 * Returns skills that have `user-invocable: true` set.
 */
export function discoverSkills(): SkillInfo[] {
  const skillsDir = join(homedir(), '.claude', 'skills')
  if (!existsSync(skillsDir)) return []

  const skills: SkillInfo[] = []

  for (const entry of readdirSync(skillsDir)) {
    const entryPath = join(skillsDir, entry)

    // Resolve symlinks
    let realPath: string
    try {
      realPath = lstatSync(entryPath).isSymbolicLink()
        ? resolve(entryPath)
        : entryPath
    } catch {
      continue
    }

    const skillFile = join(realPath, 'SKILL.md')
    if (!existsSync(skillFile)) continue

    try {
      const content = readFileSync(skillFile, 'utf8')
      const parsed = parseFrontmatter(content)
      if (!parsed) continue

      // Only include user-invocable skills
      if (parsed['user-invocable'] !== 'true') continue

      const name = parsed['name']
      const description = parsed['description']
      if (!name || !description) continue

      const hint = parsed['argument-hint']
      skills.push({
        name,
        description: description.slice(0, 100), // Telegram limits command descriptions
        ...(hint ? { argumentHint: hint } : {})
      })
    } catch {
      // Skip unreadable skills
    }
  }

  return skills
}

/**
 * Parses YAML-like frontmatter between --- markers.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match?.[1]) return null

  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx < 0) continue
    const key = line.slice(0, colonIdx).trim()
    let value = line.slice(colonIdx + 1).trim()
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    fields[key] = value
  }
  return fields
}

import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Appends timestamped entries to daily markdown log files.
 * Consolidates old logs (>30 days) into monthly summaries.
 */
export class DailyLog {
  constructor(private readonly logDir: string) {}

  /** Appends a timestamped entry to today's log file. */
  async append(conversationKey: string, role: 'user' | 'assistant', text: string): Promise<void> {
    await mkdir(this.logDir, { recursive: true })

    const now = new Date()
    const file = join(this.logDir, `${formatDate(now)}.md`)
    const time = now.toISOString().slice(11, 19)
    const line = `- **${time}** [${conversationKey}] (${role}): ${text}\n`

    await appendFile(file, line, 'utf-8')
  }

  /** Returns today's log content. */
  async getToday(): Promise<string> {
    const file = join(this.logDir, `${formatDate(new Date())}.md`)
    return readFileSafe(file)
  }

  /** Returns the last N days of logs, concatenated. */
  async getRecent(days: number): Promise<string> {
    const files = await this.listLogFiles()
    const recent = files.slice(-days)

    const parts: string[] = []
    for (const name of recent) {
      const content = await readFileSafe(join(this.logDir, name))
      if (content) {
        parts.push(`# ${name.replace('.md', '')}\n${content}`)
      }
    }

    return parts.join('\n')
  }

  /**
   * Consolidates daily logs older than `daysToKeep` into monthly summaries.
   * Moves detailed logs to an archive/ subdirectory and creates summary files.
   *
   * Summary format: one line per day with topic keywords extracted from entries.
   */
  async consolidate(daysToKeep = 30): Promise<{ archived: number; summariesCreated: number }> {
    const files = await this.listLogFiles()
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - daysToKeep)
    const cutoffStr = formatDate(cutoff)

    const toArchive = files.filter((f) => f < cutoffStr + '.md')
    if (toArchive.length === 0) return { archived: 0, summariesCreated: 0 }

    // Group by month
    const byMonth = new Map<string, string[]>()
    for (const file of toArchive) {
      const month = file.slice(0, 7) // "2026-03"
      const existing = byMonth.get(month) ?? []
      existing.push(file)
      byMonth.set(month, existing)
    }

    // Create archive dir
    const archiveDir = join(this.logDir, 'archive')
    await mkdir(archiveDir, { recursive: true })

    let archived = 0
    let summariesCreated = 0

    for (const [month, monthFiles] of byMonth) {
      // The cutoff moves daily, so a month is usually consolidated across
      // several runs — keep the day lines a previous run already wrote.
      const summaryPath = join(this.logDir, `${month}-summary.md`)
      const previous = await readFileSafe(summaryPath)
      const dayLines = previous.split('\n').filter((line) => line.startsWith('- **'))

      for (const file of monthFiles) {
        const filePath = join(this.logDir, file)
        const content = await readFileSafe(filePath)
        if (!content) continue

        const date = file.replace('.md', '')
        const topics = extractTopics(content)
        const messageCount = (content.match(/^- \*\*/gm) || []).length
        dayLines.push(`- **${date}**: ${messageCount} messages — ${topics}`)

        // Move to archive
        await rename(filePath, join(archiveDir, file))
        archived++
      }

      // Day lines start with the ISO date, so a plain sort keeps them in order.
      const summary = [`# ${month} Summary`, '', ...dayLines.sort()].join('\n')
      await writeFile(summaryPath, summary + '\n', 'utf-8')
      summariesCreated++
    }

    return { archived, summariesCreated }
  }

  private async listLogFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.logDir)
      return entries.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort()
    } catch {
      return []
    }
  }
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

async function readFileSafe(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * Extracts topic keywords from a day's log entries.
 * Looks for capitalized words, commands, and common themes.
 */
function extractTopics(content: string): string {
  const topics = new Set<string>()

  // Extract capitalized multi-word phrases (proper nouns, services)
  const properNouns = content.match(/\b[A-Z][a-zäöüß]+(?:\s+[A-Z][a-zäöüß]+)+/g)
  if (properNouns) {
    for (const noun of properNouns.slice(0, 5)) {
      topics.add(noun)
    }
  }

  // Extract slash commands
  const commands = content.match(/\/\w+/g)
  if (commands) {
    for (const cmd of commands.slice(0, 3)) {
      topics.add(cmd)
    }
  }

  // Extract common action keywords
  const actions = content.match(
    /\b(?:fix|build|deploy|test|update|create|delete|install|setup|config)\w*/gi
  )
  if (actions) {
    for (const a of actions.slice(0, 3)) {
      topics.add(a.toLowerCase())
    }
  }

  const result = Array.from(topics).slice(0, 8).join(', ')
  return result || 'general conversation'
}

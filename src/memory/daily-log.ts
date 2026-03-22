import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Appends timestamped entries to daily markdown log files.
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

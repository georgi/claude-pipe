import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DailyLog } from '../src/memory/daily-log.js'

describe('DailyLog', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pi-pipe-daily-log-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('appends entries to a per-day file', async () => {
    const log = new DailyLog(dir)
    await log.append('telegram:1', 'user', 'hello there')
    await log.append('telegram:1', 'assistant', 'hi back')

    const today = new Date().toISOString().slice(0, 10)
    const file = join(dir, `${today}.md`)
    const content = await readFile(file, 'utf-8')

    expect(content).toContain('telegram:1')
    expect(content).toContain('(user): hello there')
    expect(content).toContain('(assistant): hi back')
  })

  it('creates the log directory if it does not exist', async () => {
    const nested = join(dir, 'nested', 'path')
    const log = new DailyLog(nested)

    await log.append('cli:1', 'user', 'first message')

    const files = await readdir(nested)
    expect(files.some((f) => f.endsWith('.md'))).toBe(true)
  })

  it('returns todays log content', async () => {
    const log = new DailyLog(dir)
    await log.append('discord:abc', 'user', 'question about pi')

    const today = await log.getToday()
    expect(today).toContain('question about pi')
  })

  it('returns empty string when no log for today', async () => {
    const log = new DailyLog(dir)
    expect(await log.getToday()).toBe('')
  })

  it('getRecent concatenates the last N days of logs in order', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '2026-04-01.md'), '- day one\n', 'utf-8')
    await writeFile(join(dir, '2026-04-02.md'), '- day two\n', 'utf-8')
    await writeFile(join(dir, '2026-04-03.md'), '- day three\n', 'utf-8')
    // Non-matching file is ignored
    await writeFile(join(dir, 'README.md'), 'ignored\n', 'utf-8')

    const log = new DailyLog(dir)
    const recent = await log.getRecent(2)

    expect(recent).toContain('# 2026-04-02')
    expect(recent).toContain('day two')
    expect(recent).toContain('# 2026-04-03')
    expect(recent).toContain('day three')
    expect(recent).not.toContain('day one')
    expect(recent).not.toContain('ignored')
  })

  it('getRecent returns empty string when directory is missing', async () => {
    const log = new DailyLog(join(dir, 'never-created'))
    expect(await log.getRecent(7)).toBe('')
  })
})

describe('DailyLog.consolidate', () => {
  let dir: string
  let log: DailyLog

  const writeDay = (date: string, lines: string[]) =>
    writeFileSync(
      join(dir, `${date}.md`),
      lines.map((l) => `- **10:00:00** [c] (user): ${l}\n`).join('')
    )

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daily-log-'))
    log = new DailyLog(dir)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('archives old days into a monthly summary and keeps recent ones', async () => {
    writeDay('2026-03-01', ['fix the Minecraft Server', 'hello'])
    writeDay('2026-04-20', ['recent'])
    vi.setSystemTime(new Date('2026-05-01T12:00:00'))

    const result = await log.consolidate(30)

    expect(result).toEqual({ archived: 1, summariesCreated: 1 })
    expect(readdirSync(join(dir, 'archive'))).toEqual(['2026-03-01.md'])
    expect(readdirSync(dir)).toContain('2026-04-20.md')
    const summary = readFileSync(join(dir, '2026-03-summary.md'), 'utf-8')
    expect(summary).toContain('# 2026-03 Summary')
    expect(summary).toContain('- **2026-03-01**: 2 messages — Minecraft Server')
  })

  it('adds to an existing monthly summary instead of overwriting it', async () => {
    writeDay('2026-03-01', ['first day'])
    writeDay('2026-03-02', ['second day'])

    vi.setSystemTime(new Date('2026-04-01T12:00:00'))
    await log.consolidate(30) // cutoff 2026-03-02: only the 1st is archived
    vi.setSystemTime(new Date('2026-04-02T12:00:00'))
    await log.consolidate(30) // the 2nd follows a day later

    const dayLines = readFileSync(join(dir, '2026-03-summary.md'), 'utf-8')
      .split('\n')
      .filter((l) => l.startsWith('- **'))
    expect(dayLines).toHaveLength(2)
    expect(dayLines[0]).toContain('2026-03-01')
    expect(dayLines[1]).toContain('2026-03-02')
  })

  it('is a no-op when nothing is old enough', async () => {
    writeDay('2026-04-20', ['recent'])
    vi.setSystemTime(new Date('2026-05-01T12:00:00'))

    expect(await log.consolidate(30)).toEqual({ archived: 0, summariesCreated: 0 })
  })
})

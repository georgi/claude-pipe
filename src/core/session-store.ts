import { mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { SessionMap, SessionRecord } from './types.js'

const LOCK_RETRIES = 10
const LOCK_RETRY_DELAY_MS = 50
const LOCK_STALE_MS = 10_000

/**
 * File-backed session ID map.
 *
 * Persists only conversation key -> Claude session ID metadata.
 * Uses a directory-based lockfile to prevent concurrent write corruption
 * across multiple processes.
 */
export class SessionStore {
  private readonly path: string
  private readonly lockPath: string
  private map: SessionMap = {}

  constructor(path: string) {
    this.path = path
    this.lockPath = `${path}.lock`
  }

  /** Loads persisted map state and ensures data directory exists. */
  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    try {
      const raw = await readFile(this.path, 'utf-8')
      this.map = JSON.parse(raw) as SessionMap
    } catch {
      this.map = {}
    }
  }

  /** Gets session mapping for a conversation key. */
  get(conversationKey: string): SessionRecord | undefined {
    return this.map[conversationKey]
  }

  /** Returns a shallow copy of all session entries. */
  entries(): Readonly<SessionMap> {
    return { ...this.map }
  }

  /** Upserts conversation mapping and persists to disk atomically. */
  async set(conversationKey: string, sessionId: string): Promise<void> {
    this.map[conversationKey] = {
      sessionId,
      updatedAt: new Date().toISOString()
    }
    await this.persist()
  }

  /** Deletes conversation mapping and persists if it existed. */
  async clear(conversationKey: string): Promise<void> {
    if (!(conversationKey in this.map)) return
    delete this.map[conversationKey]
    await this.persist()
  }

  private async persist(): Promise<void> {
    await this.acquireLock()
    try {
      const tmp = `${this.path}.tmp`
      await writeFile(tmp, JSON.stringify(this.map, null, 2), 'utf-8')
      await rename(tmp, this.path)
    } finally {
      await this.releaseLock()
    }
  }

  /**
   * Acquires a directory-based lock. `mkdir` is atomic on all major platforms,
   * so only one process will succeed in creating the lock directory.
   * Retries with linear backoff and breaks stale locks older than LOCK_STALE_MS.
   */
  private async acquireLock(): Promise<void> {
    for (let i = 0; i < LOCK_RETRIES; i++) {
      try {
        await mkdir(this.lockPath)
        return
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        await this.breakStaleLock()
        await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS * (i + 1)))
      }
    }
    throw new Error(`Failed to acquire lock after ${LOCK_RETRIES} retries: ${this.lockPath}`)
  }

  private async releaseLock(): Promise<void> {
    try {
      await rmdir(this.lockPath)
    } catch {
      /* lock already removed — safe to ignore */
    }
  }

  /** Removes a stale lock directory if it is older than LOCK_STALE_MS. */
  private async breakStaleLock(): Promise<void> {
    try {
      const info = await stat(this.lockPath)
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rmdir(this.lockPath)
      }
    } catch {
      /* lock disappeared between check and removal — fine */
    }
  }
}

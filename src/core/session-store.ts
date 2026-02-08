import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { SessionMap, SessionRecord } from './types.js'

/**
 * File-backed session ID map.
 *
 * Persists only conversation key -> Claude session ID metadata.
 */
export class SessionStore {
  private readonly path: string
  private map: SessionMap = {}

  constructor(path: string) {
    this.path = path
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
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, JSON.stringify(this.map, null, 2), 'utf-8')
    await rename(tmp, this.path)
  }
}

/**
 * Stub — full implementation lives on feat/memory-store.
 *
 * SQLite-backed memory store with FTS5 full-text search.
 */
export interface MemoryEntry {
  key: string
  content: string
  metadata: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export class MemoryStore {
  constructor(_dbPath: string) {}

  init(): void {
    // stub
  }

  save(_key: string, _content: string, _metadata?: Record<string, unknown>): void {
    // stub
  }

  search(_query: string, _limit?: number): MemoryEntry[] {
    return []
  }

  list(_prefix?: string): string[] {
    return []
  }

  get(_key: string): MemoryEntry | undefined {
    return undefined
  }

  delete(_key: string): void {
    // stub
  }

  close(): void {
    // stub
  }
}

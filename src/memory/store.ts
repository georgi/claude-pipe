import Database from 'better-sqlite3'

export interface MemoryEntry {
  key: string
  content: string
  metadata: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

/**
 * SQLite-backed memory store with FTS5 full-text search.
 */
export class MemoryStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
  }

  /** Creates tables and triggers if they don't exist. */
  init(): void {
    this.db.pragma('journal_mode = WAL')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        key TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        key, content, content=memories, content_rowid=rowid
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, key, content)
        VALUES (new.rowid, new.key, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, content)
        VALUES ('delete', old.rowid, old.key, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, content)
        VALUES ('delete', old.rowid, old.key, old.content);
        INSERT INTO memories_fts(rowid, key, content)
        VALUES (new.rowid, new.key, new.content);
      END;
    `)
  }

  /** Upserts a memory entry. */
  save(key: string, content: string, metadata?: Record<string, unknown>): void {
    const now = new Date().toISOString()
    const meta = metadata ? JSON.stringify(metadata) : null

    this.db
      .prepare(
        `INSERT INTO memories (key, content, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           content = excluded.content,
           metadata = excluded.metadata,
           updated_at = excluded.updated_at`
      )
      .run(key, content, meta, now, now)
  }

  /** Hybrid search using FTS5. Returns matches ranked by relevance. */
  search(query: string, limit = 10): MemoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT m.key, m.content, m.metadata, m.created_at, m.updated_at
         FROM memories_fts fts
         JOIN memories m ON m.rowid = fts.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(query, limit) as Array<{
      key: string
      content: string
      metadata: string | null
      created_at: string
      updated_at: string
    }>

    return rows.map(toMemoryEntry)
  }

  /** Lists all memory keys, optionally filtered by prefix. */
  list(prefix?: string): string[] {
    if (prefix) {
      const rows = this.db
        .prepare('SELECT key FROM memories WHERE key LIKE ? ORDER BY key')
        .all(`${prefix}%`) as Array<{ key: string }>
      return rows.map((r) => r.key)
    }

    const rows = this.db
      .prepare('SELECT key FROM memories ORDER BY key')
      .all() as Array<{ key: string }>
    return rows.map((r) => r.key)
  }

  /** Gets a specific memory by key. */
  get(key: string): MemoryEntry | undefined {
    const row = this.db
      .prepare(
        'SELECT key, content, metadata, created_at, updated_at FROM memories WHERE key = ?'
      )
      .get(key) as
      | {
          key: string
          content: string
          metadata: string | null
          created_at: string
          updated_at: string
        }
      | undefined

    return row ? toMemoryEntry(row) : undefined
  }

  /** Deletes a memory by key. */
  delete(key: string): void {
    this.db.prepare('DELETE FROM memories WHERE key = ?').run(key)
  }

  /** Closes the database connection. */
  close(): void {
    this.db.close()
  }
}

function toMemoryEntry(row: {
  key: string
  content: string
  metadata: string | null
  created_at: string
  updated_at: string
}): MemoryEntry {
  return {
    key: row.key,
    content: row.content,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

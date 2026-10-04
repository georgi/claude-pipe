import Database from 'better-sqlite3'

export interface MemoryEntry {
  key: string
  content: string
  metadata: Record<string, unknown> | null
  type: string | null
  entityTags: string[] | null
  confidence: string | null
  accessCount: number
  lastAccessed: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Optional fields for `save()`. Omitted fields keep their stored value when a
 * key is updated; new entries get `confidence: 'medium'` unless given.
 */
export interface SaveOptions {
  metadata?: Record<string, unknown>
  type?: string
  entityTags?: string[]
  confidence?: string
}

/** Bump together with a new entry in `MIGRATIONS`. */
const SCHEMA_VERSION = 1

/** Max FTS terms taken from a search query, to keep MATCH expressions small. */
const MAX_SEARCH_TERMS = 32

/** Half-life (days) of the recency boost applied to search scores. */
const RECENCY_HALF_LIFE_DAYS = 14

const ENTRY_COLUMNS = `key, content, metadata, type, entity_tags, confidence,
  access_count, last_accessed, created_at, updated_at`

/**
 * SQLite-backed memory store with FTS5 full-text search,
 * recency-weighted scoring, entity tagging, and access tracking.
 */
export class MemoryStore {
  private readonly db: Database.Database
  private readonly statements = new Map<string, Database.Statement>()

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
  }

  /** Configures the connection and brings the schema up to date. */
  init(): void {
    this.db.pragma('journal_mode = WAL')
    // Wait for concurrent writers (other pipe processes) instead of failing
    // immediately with SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000')

    const current = this.db.pragma('user_version', { simple: true }) as number
    for (let version = current; version < SCHEMA_VERSION; version++) {
      this.db.transaction(() => {
        MIGRATIONS[version]!(this.db)
        this.db.pragma(`user_version = ${version + 1}`)
      })()
    }
  }

  /** Upserts a memory entry. See `SaveOptions` for how omitted fields behave. */
  save(key: string, content: string, opts: SaveOptions = {}): void {
    const now = new Date().toISOString()
    this.stmt(
      `INSERT INTO memories (key, content, metadata, type, entity_tags, confidence, created_at, updated_at)
       VALUES (@key, @content, @metadata, @type, @entityTags, COALESCE(@confidence, 'medium'), @now, @now)
       ON CONFLICT(key) DO UPDATE SET
         content = excluded.content,
         metadata = COALESCE(@metadata, metadata),
         type = COALESCE(@type, type),
         entity_tags = COALESCE(@entityTags, entity_tags),
         confidence = COALESCE(@confidence, confidence),
         updated_at = excluded.updated_at`
    ).run({
      key,
      content,
      metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
      type: opts.type ?? null,
      entityTags: opts.entityTags ? JSON.stringify(opts.entityTags) : null,
      confidence: opts.confidence ?? null,
      now
    })
  }

  /**
   * Full-text search ranked by BM25, boosted by recency and access frequency.
   *
   * All words of the query go into one OR'ed FTS expression, so every
   * candidate is scored on the same BM25 scale. Returned entries have their
   * access stats updated.
   */
  search(query: string, limit = 10): MemoryEntry[] {
    const ftsQuery = toFtsQuery(query)
    if (!ftsQuery) return []

    const rows = this.stmt(
      `SELECT ${prefixed('m', ENTRY_COLUMNS)}, memories_fts.rank AS bm25_rank
       FROM memories_fts
       JOIN memories m ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ?
       ORDER BY memories_fts.rank
       LIMIT ?`
    ).all(ftsQuery, limit * 3) as Array<RawRow & { bm25_rank: number }>

    const results = rows
      .map((row) => {
        const entry = toMemoryEntry(row)
        const recencyBoost = recencyScore(entry.updatedAt)
        const accessBoost = Math.min(entry.accessCount * 0.05, 0.3)
        // FTS5 rank is negative BM25: more negative = better match.
        return { entry, score: -row.bm25_rank * (1 + recencyBoost + accessBoost) }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.entry)

    if (results.length > 0) this.trackAccess(results.map((r) => r.key))
    return results
  }

  /**
   * Finds memories by entity tag. An exact tag (`person:yasmin`) matches that
   * tag only; a bare kind (`person`) matches every tag of that kind.
   */
  searchByEntity(tag: string, limit = 10): MemoryEntry[] {
    const rows = this.stmt(
      `SELECT ${ENTRY_COLUMNS} FROM memories
       WHERE EXISTS (
         SELECT 1 FROM json_each(memories.entity_tags) t
         WHERE t.value = @tag OR t.value LIKE @kindPrefix ESCAPE '\\'
       )
       ORDER BY updated_at DESC
       LIMIT @limit`
    ).all({ tag, kindPrefix: `${escapeLike(tag)}:%`, limit }) as RawRow[]

    return rows.map(toMemoryEntry)
  }

  /** Lists memory keys, optionally filtered by type or key prefix. */
  list(opts?: { prefix?: string; type?: string }): string[] {
    let rows: Array<{ key: string }>
    if (opts?.type) {
      rows = this.stmt('SELECT key FROM memories WHERE type = ? ORDER BY updated_at DESC').all(
        opts.type
      ) as Array<{ key: string }>
    } else if (opts?.prefix) {
      rows = this.stmt(`SELECT key FROM memories WHERE key LIKE ? ESCAPE '\\' ORDER BY key`).all(
        `${escapeLike(opts.prefix)}%`
      ) as Array<{ key: string }>
    } else {
      rows = this.stmt('SELECT key FROM memories ORDER BY updated_at DESC').all() as Array<{
        key: string
      }>
    }
    return rows.map((r) => r.key)
  }

  /** Gets a specific memory by key. */
  get(key: string): MemoryEntry | undefined {
    const row = this.stmt(`SELECT ${ENTRY_COLUMNS} FROM memories WHERE key = ?`).get(key) as
      | RawRow
      | undefined
    return row ? toMemoryEntry(row) : undefined
  }

  /** Deletes a memory by key. */
  delete(key: string): void {
    this.stmt('DELETE FROM memories WHERE key = ?').run(key)
  }

  /** Returns memory count, per-type counts, and entries unused for 90 days. */
  stats(): { total: number; byType: Record<string, number>; stale: number } {
    const total = (this.stmt('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c

    const typeRows = this.stmt(
      "SELECT COALESCE(type, 'untyped') AS t, COUNT(*) AS c FROM memories GROUP BY type"
    ).all() as Array<{ t: string; c: number }>
    const byType: Record<string, number> = {}
    for (const r of typeRows) byType[r.t] = r.c

    const cutoff = new Date(Date.now() - 90 * 86400_000).toISOString()
    const stale = (
      this.stmt(
        'SELECT COUNT(*) AS c FROM memories WHERE COALESCE(last_accessed, updated_at) < ?'
      ).get(cutoff) as { c: number }
    ).c

    return { total, byType, stale }
  }

  /** Closes the database connection. */
  close(): void {
    this.db.close()
  }

  /** Prepares a statement once per connection and reuses it afterwards. */
  private stmt(sql: string): Database.Statement {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  /** Updates access_count and last_accessed for retrieved memories. */
  private trackAccess(keys: string[]): void {
    const now = new Date().toISOString()
    const update = this.stmt(
      'UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE key = ?'
    )
    this.db.transaction(() => {
      for (const key of keys) update.run(now, key)
    })()
  }
}

/**
 * Schema migrations, indexed by the `user_version` they upgrade from. Each
 * runs inside a transaction together with the version bump.
 */
const MIGRATIONS: Array<(db: Database.Database) => void> = [
  // v0 → v1: explicit INTEGER PRIMARY KEY (the implicit rowid an external-
  // content FTS index points at can be renumbered by VACUUM), metadata
  // columns, FTS triggers limited to indexed columns, and indexes.
  (db) => {
    const legacyColumns = new Set(
      (db.prepare("PRAGMA table_info('memories')").all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    )

    db.exec(`
      DROP TRIGGER IF EXISTS memories_ai;
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_au;
      DROP TABLE IF EXISTS memories_fts;

      CREATE TABLE memories_v1 (
        id INTEGER PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        metadata TEXT,
        type TEXT,
        entity_tags TEXT,
        confidence TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)

    if (legacyColumns.size > 0) {
      // Older databases may predate some columns (or have them from an
      // unversioned ad-hoc migration); fill in defaults for missing ones.
      const col = (name: string, fallback: string) => (legacyColumns.has(name) ? name : fallback)
      db.exec(`
        INSERT INTO memories_v1 (key, content, metadata, type, entity_tags, confidence,
                                 access_count, last_accessed, created_at, updated_at)
        SELECT key, content, metadata, ${col('type', 'NULL')}, ${col('entity_tags', 'NULL')},
               ${col('confidence', "'medium'")}, COALESCE(${col('access_count', '0')}, 0),
               ${col('last_accessed', 'NULL')}, created_at, updated_at
        FROM memories;
        DROP TABLE memories;
      `)
    }

    db.exec(`
      ALTER TABLE memories_v1 RENAME TO memories;

      CREATE INDEX memories_type_idx ON memories(type);
      CREATE INDEX memories_updated_at_idx ON memories(updated_at);

      CREATE VIRTUAL TABLE memories_fts USING fts5(
        key, content, content=memories, content_rowid=id
      );
      INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');

      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, key, content)
        VALUES (new.id, new.key, new.content);
      END;

      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, content)
        VALUES ('delete', old.id, old.key, old.content);
      END;

      -- Only reindex when indexed text changes, not on access tracking.
      CREATE TRIGGER memories_au AFTER UPDATE OF key, content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, content)
        VALUES ('delete', old.id, old.key, old.content);
        INSERT INTO memories_fts(rowid, key, content)
        VALUES (new.id, new.key, new.content);
      END;
    `)
  }
]

/**
 * Turns free text into a safe FTS5 expression: each word becomes a quoted
 * term (so FTS operators and syntax in user input are inert), OR'ed together.
 */
function toFtsQuery(input: string): string {
  const seen = new Set<string>()
  for (const word of input.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (word.length < 2) continue
    seen.add(word.toLowerCase())
    if (seen.size >= MAX_SEARCH_TERMS) break
  }
  return Array.from(seen, (w) => `"${w}"`).join(' OR ')
}

/** Recency boost from 1.0 (just updated) decaying towards 0. */
function recencyScore(updatedAt: string): number {
  const ageDays = (Date.now() - new Date(updatedAt).getTime()) / 86400_000
  return Math.pow(0.5, Math.max(ageDays, 0) / RECENCY_HALF_LIFE_DAYS)
}

/** Escapes LIKE wildcards; use with `ESCAPE '\'`. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function prefixed(alias: string, columns: string): string {
  return columns
    .split(',')
    .map((c) => `${alias}.${c.trim()}`)
    .join(', ')
}

interface RawRow {
  key: string
  content: string
  metadata: string | null
  type: string | null
  entity_tags: string | null
  confidence: string | null
  access_count: number
  last_accessed: string | null
  created_at: string
  updated_at: string
}

function toMemoryEntry(row: RawRow): MemoryEntry {
  return {
    key: row.key,
    content: row.content,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    type: row.type,
    entityTags: row.entity_tags ? (JSON.parse(row.entity_tags) as string[]) : null,
    confidence: row.confidence,
    accessCount: row.access_count ?? 0,
    lastAccessed: row.last_accessed,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

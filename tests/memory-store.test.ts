import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import Database from 'better-sqlite3'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MemoryStore } from '../src/memory/store.js'

describe('MemoryStore', () => {
  let dir: string
  let store: MemoryStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-pipe-memory-'))
    store = new MemoryStore(join(dir, 'memory.sqlite'))
    store.init()
  })

  afterEach(async () => {
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('saves and retrieves a memory by key', () => {
    store.save('user_lang', 'prefers English')

    const got = store.get('user_lang')
    expect(got?.content).toBe('prefers English')
    expect(got?.key).toBe('user_lang')
    expect(got?.metadata).toBeNull()
    expect(got?.createdAt).toBeTruthy()
    expect(got?.updatedAt).toBeTruthy()
  })

  it('stores and parses metadata as JSON', () => {
    store.save('project_x', 'has 3 services', { metadata: { service_count: 3, owner: 'alice' } })

    const got = store.get('project_x')
    expect(got?.metadata).toEqual({ service_count: 3, owner: 'alice' })
  })

  it('upserts existing entries via ON CONFLICT', () => {
    store.save('k1', 'first')
    const first = store.get('k1')
    store.save('k1', 'second')
    const second = store.get('k1')

    expect(second?.content).toBe('second')
    expect(second?.createdAt).toBe(first?.createdAt)
  })

  it('returns undefined for missing key', () => {
    expect(store.get('nope')).toBeUndefined()
  })

  it('lists all keys, most recently updated first', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    store.save('b', 'second')
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'))
    store.save('a', 'first')
    vi.setSystemTime(new Date('2026-01-03T00:00:00Z'))
    store.save('c', 'third')
    vi.useRealTimers()

    expect(store.list()).toEqual(['c', 'a', 'b'])
  })

  it('filters list by prefix', () => {
    store.save('user_lang', 'x')
    store.save('user_tz', 'y')
    store.save('project_a', 'z')

    expect(store.list({ prefix: 'user_' })).toEqual(['user_lang', 'user_tz'])
  })

  it('deletes a memory by key', () => {
    store.save('temp', 'value')
    store.delete('temp')

    expect(store.get('temp')).toBeUndefined()
    expect(store.list()).not.toContain('temp')
  })

  it('finds memories via FTS5 full-text search', () => {
    store.save('a', 'the quick brown fox jumps')
    store.save('b', 'a lazy dog sleeps')
    store.save('c', 'the fox is clever')

    const results = store.search('fox')
    const keys = results.map((r) => r.key).sort()
    expect(keys).toContain('a')
    expect(keys).toContain('c')
    expect(keys).not.toContain('b')
  })

  it('respects search limit', () => {
    for (let i = 0; i < 10; i++) {
      store.save(`note_${i}`, 'searchable text')
    }

    const results = store.search('searchable', 3)
    expect(results).toHaveLength(3)
  })

  it('reflects FTS index updates after deletes', () => {
    store.save('a', 'banana stand here')
    expect(store.search('banana')).toHaveLength(1)

    store.delete('a')
    expect(store.search('banana')).toHaveLength(0)
  })

  it('reflects FTS index updates after content updates', () => {
    store.save('a', 'old text')
    store.save('a', 'phoenix rising')

    expect(store.search('phoenix')).toHaveLength(1)
    expect(store.search('old')).toHaveLength(0)
  })
})

describe('MemoryStore typed memories and schema', () => {
  let dir: string
  let dbPath: string
  let store: MemoryStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-store-'))
    dbPath = join(dir, 'memory.sqlite')
    store = new MemoryStore(dbPath)
    store.init()
  })

  afterEach(() => {
    store.close()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('save / get', () => {
    it('stores content with metadata and defaults confidence to medium', () => {
      store.save('pref_lang', 'Prefers German', { type: 'preference' })

      const entry = store.get('pref_lang')
      expect(entry).toMatchObject({
        key: 'pref_lang',
        content: 'Prefers German',
        type: 'preference',
        confidence: 'medium',
        accessCount: 0,
        entityTags: null
      })
    })

    it('keeps stored fields that an update omits', () => {
      store.save('k', 'v1', {
        type: 'fact',
        confidence: 'high',
        entityTags: ['person:yasmin'],
        metadata: { source: 'chat' }
      })
      store.save('k', 'v2')

      expect(store.get('k')).toMatchObject({
        content: 'v2',
        type: 'fact',
        confidence: 'high',
        entityTags: ['person:yasmin'],
        metadata: { source: 'chat' }
      })
    })

    it('overwrites fields an update provides', () => {
      store.save('k', 'v1', { confidence: 'low' })
      store.save('k', 'v2', { confidence: 'high' })

      expect(store.get('k')?.confidence).toBe('high')
    })

    it('deletes entries and removes them from search', () => {
      store.save('k', 'kangaroo facts')
      store.delete('k')

      expect(store.get('k')).toBeUndefined()
      expect(store.search('kangaroo')).toEqual([])
    })
  })

  describe('search', () => {
    it('finds entries by any word of the query', () => {
      store.save('bank', 'Uses bunq for banking')
      store.save('pet', 'Has a cat named Mia')

      const results = store.search('which bank? bunq or something else')

      expect(results.map((r) => r.key)).toEqual(['bank'])
    })

    it('treats FTS syntax in the query as plain words', () => {
      store.save('k', 'deploy notes for the NEAR server')

      expect(() => store.search('NEAR( "deploy* AND -x OR: ^notes')).not.toThrow()
      expect(store.search('NEAR( "deploy* AND -x OR: ^notes').map((r) => r.key)).toEqual(['k'])
    })

    it('returns nothing for queries without words', () => {
      store.save('k', 'something')
      expect(store.search('?! -- ""')).toEqual([])
    })

    it('ranks recently updated entries above stale ones with equal text relevance', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      store.save('old', 'minecraft server backup')
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
      store.save('new', 'minecraft server backup')

      expect(store.search('minecraft backup').map((r) => r.key)).toEqual(['new', 'old'])
    })

    it('tracks access without re-indexing the entry', () => {
      store.save('k', 'zebra stripes')

      store.search('zebra')
      store.search('zebra')

      const entry = store.get('k')
      expect(entry?.accessCount).toBe(2)
      expect(entry?.lastAccessed).not.toBeNull()
      // Still exactly one FTS hit: access updates must not duplicate index rows.
      expect(store.search('zebra')).toHaveLength(1)
    })
  })

  describe('searchByEntity', () => {
    beforeEach(() => {
      store.save('a', 'Yasmin likes tea', { entityTags: ['person:yasmin'] })
      store.save('b', 'Yas is a nickname', { entityTags: ['person:yas'] })
      store.save('c', 'Bank account', { entityTags: ['service:bunq'] })
      store.save('d', 'Odd tag', { entityTags: ['person:a_b%'] })
    })

    it('matches an exact tag only', () => {
      expect(store.searchByEntity('person:yas').map((e) => e.key)).toEqual(['b'])
    })

    it('matches all tags of a kind', () => {
      expect(
        store
          .searchByEntity('person')
          .map((e) => e.key)
          .sort()
      ).toEqual(['a', 'b', 'd'])
    })

    it('treats LIKE wildcards literally', () => {
      expect(store.searchByEntity('person:a_b%').map((e) => e.key)).toEqual(['d'])
      expect(store.searchByEntity('%')).toEqual([])
    })
  })

  describe('list / stats', () => {
    it('filters keys by type and escaped prefix', () => {
      store.save('user_lang', 'German', { type: 'preference' })
      store.save('user%x', 'odd', { type: 'fact' })
      store.save('project_a', 'stuff', { type: 'project' })

      expect(store.list({ type: 'preference' })).toEqual(['user_lang'])
      expect(store.list({ prefix: 'user%' })).toEqual(['user%x'])
      expect(store.list().sort()).toEqual(['project_a', 'user%x', 'user_lang'])
    })

    it('counts entries per type and stale entries', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      store.save('stale', 'old', { type: 'fact' })
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
      store.save('fresh', 'new')

      expect(store.stats()).toEqual({ total: 2, byType: { fact: 1, untyped: 1 }, stale: 1 })
    })
  })

  describe('schema', () => {
    it('uses an explicit integer primary key and records the schema version', () => {
      const db = new Database(dbPath, { readonly: true })
      const columns = db.prepare("PRAGMA table_info('memories')").all() as Array<{
        name: string
        pk: number
      }>
      expect(columns.find((c) => c.pk === 1)?.name).toBe('id')
      expect(db.pragma('user_version', { simple: true })).toBe(1)
      db.close()
    })

    it('is idempotent across restarts', () => {
      store.save('k', 'persisted value')
      store.close()

      store = new MemoryStore(dbPath)
      store.init()

      expect(store.search('persisted').map((r) => r.key)).toEqual(['k'])
    })

    it('keeps the search index in sync after VACUUM', () => {
      store.save('a', 'alpha')
      store.save('b', 'bravo')
      store.save('c', 'charlie')
      store.delete('a')
      store.close()

      const db = new Database(dbPath)
      db.exec('VACUUM')
      db.close()

      store = new MemoryStore(dbPath)
      store.init()
      expect(store.search('charlie').map((r) => r.content)).toEqual(['charlie'])
    })

    it('migrates a legacy database without losing data', () => {
      store.close()
      rmSync(dbPath)
      rmSync(`${dbPath}-wal`, { force: true })
      rmSync(`${dbPath}-shm`, { force: true })

      // Schema as shipped before versioned migrations.
      const legacy = new Database(dbPath)
      legacy.exec(`
        CREATE TABLE memories (
          key TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          metadata TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          key, content, content=memories, content_rowid=rowid
        );
        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, key, content)
          VALUES (new.rowid, new.key, new.content);
        END;
        INSERT INTO memories VALUES
          ('legacy', 'old giraffe memory', '{"src":"v0"}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      `)
      legacy.close()

      store = new MemoryStore(dbPath)
      store.init()

      expect(store.get('legacy')).toMatchObject({
        content: 'old giraffe memory',
        metadata: { src: 'v0' },
        confidence: 'medium',
        accessCount: 0
      })
      expect(store.search('giraffe').map((r) => r.key)).toEqual(['legacy'])
    })
  })
})

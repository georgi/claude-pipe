import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SessionStore } from '../src/core/session-store.js'

describe('SessionStore', () => {
  it('persists and reloads session records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-pipe-test-'))
    const path = join(dir, 'sessions.json')

    const store = new SessionStore(path)
    await store.init()
    await store.set('telegram:123', '/sessions/sess-abc.jsonl')

    const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<
      string,
      { sessionFile: string }
    >
    expect(raw['telegram:123']?.sessionFile).toBe('/sessions/sess-abc.jsonl')

    const reloaded = new SessionStore(path)
    await reloaded.init()
    expect(reloaded.get('telegram:123')?.sessionFile).toBe('/sessions/sess-abc.jsonl')
  })

  it('clears an existing session record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-pipe-test-'))
    const path = join(dir, 'sessions.json')

    const store = new SessionStore(path)
    await store.init()
    await store.set('telegram:123', '/sessions/sess-abc.jsonl')
    await store.clear('telegram:123')

    expect(store.get('telegram:123')).toBeUndefined()

    const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<
      string,
      { sessionFile: string }
    >
    expect(raw['telegram:123']).toBeUndefined()
  })

  it('releases lockfile after persist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-pipe-test-'))
    const path = join(dir, 'sessions.json')
    const lockPath = `${path}.lock`

    const store = new SessionStore(path)
    await store.init()
    await store.set('telegram:456', '/sessions/sess-xyz.jsonl')

    // Lock directory should not exist after write completes
    await expect(access(lockPath)).rejects.toThrow()
  })

  it('handles concurrent writes without corruption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-pipe-test-'))
    const path = join(dir, 'sessions.json')

    const store = new SessionStore(path)
    await store.init()

    // Fire multiple concurrent writes
    await Promise.all([
      store.set('a:1', '/sessions/sess-1.jsonl'),
      store.set('a:2', '/sessions/sess-2.jsonl'),
      store.set('a:3', '/sessions/sess-3.jsonl')
    ])

    // All entries should be present
    expect(store.get('a:1')?.sessionFile).toBe('/sessions/sess-1.jsonl')
    expect(store.get('a:2')?.sessionFile).toBe('/sessions/sess-2.jsonl')
    expect(store.get('a:3')?.sessionFile).toBe('/sessions/sess-3.jsonl')

    // File should be valid JSON
    const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<
      string,
      { sessionFile: string }
    >
    expect(Object.keys(raw)).toHaveLength(3)
  })

  it('entries() returns a snapshot independent of subsequent writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-pipe-test-'))
    const path = join(dir, 'sessions.json')
    const store = new SessionStore(path)
    await store.init()

    await store.set('k1', '/p/k1.jsonl')
    const snapshot = store.entries()
    expect(Object.keys(snapshot)).toEqual(['k1'])

    await store.set('k2', '/p/k2.jsonl')
    // The snapshot is a shallow copy — must not include the later write
    expect(Object.keys(snapshot)).toEqual(['k1'])
  })

  it('clear() on an unknown key is a no-op', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-pipe-test-'))
    const path = join(dir, 'sessions.json')
    const store = new SessionStore(path)
    await store.init()

    await store.clear('nope')
    expect(store.get('nope')).toBeUndefined()
  })

  it('reads back an empty map when the file does not exist or is unreadable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-pipe-test-'))
    const store = new SessionStore(join(dir, 'never-existed.json'))
    await store.init()
    expect(store.entries()).toEqual({})
  })

  it('breaks stale lock and succeeds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-pipe-test-'))
    const path = join(dir, 'sessions.json')
    const lockPath = `${path}.lock`

    // Create a stale lock directory with an old mtime
    await mkdir(lockPath)
    const { utimes } = await import('node:fs/promises')
    const past = new Date(Date.now() - 30_000)
    await utimes(lockPath, past, past)

    const store = new SessionStore(path)
    await store.init()

    // Should succeed despite stale lock
    await store.set('telegram:789', '/sessions/sess-stale.jsonl')
    expect(store.get('telegram:789')?.sessionFile).toBe('/sessions/sess-stale.jsonl')
  })
})

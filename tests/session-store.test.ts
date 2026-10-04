import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SessionStore, sessionForHarness } from '../src/core/session-store.js'

describe('SessionStore', () => {
  it('persists and reloads session records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-pipe-test-'))
    const path = join(dir, 'sessions.json')

    const store = new SessionStore(path)
    await store.init()
    await store.set('telegram:123', { sessionFile: '/sessions/sess-abc.jsonl' })

    const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<string, { sessionFile: string }>
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
    await store.set('telegram:123', { sessionFile: '/sessions/sess-abc.jsonl' })
    await store.clear('telegram:123')

    expect(store.get('telegram:123')).toBeUndefined()

    const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<string, { sessionFile: string }>
    expect(raw['telegram:123']).toBeUndefined()
  })

  it('releases lockfile after persist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-pipe-test-'))
    const path = join(dir, 'sessions.json')
    const lockPath = `${path}.lock`

    const store = new SessionStore(path)
    await store.init()
    await store.set('telegram:456', { sessionFile: '/sessions/sess-xyz.jsonl' })

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
      store.set('a:1', { sessionFile: '/sessions/sess-1.jsonl' }),
      store.set('a:2', { sessionFile: '/sessions/sess-2.jsonl' }),
      store.set('a:3', { sessionFile: '/sessions/sess-3.jsonl' })
    ])

    // All entries should be present
    expect(store.get('a:1')?.sessionFile).toBe('/sessions/sess-1.jsonl')
    expect(store.get('a:2')?.sessionFile).toBe('/sessions/sess-2.jsonl')
    expect(store.get('a:3')?.sessionFile).toBe('/sessions/sess-3.jsonl')

    // File should be valid JSON
    const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<string, { sessionFile: string }>
    expect(Object.keys(raw)).toHaveLength(3)
  })

  it('entries() returns a snapshot independent of subsequent writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-pipe-test-'))
    const path = join(dir, 'sessions.json')
    const store = new SessionStore(path)
    await store.init()

    await store.set('k1', { sessionFile: '/p/k1.jsonl' })
    const snapshot = store.entries()
    expect(Object.keys(snapshot)).toEqual(['k1'])

    await store.set('k2', { sessionFile: '/p/k2.jsonl' })
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
    await store.set('telegram:789', { sessionFile: '/sessions/sess-stale.jsonl' })
    expect(store.get('telegram:789')?.sessionFile).toBe('/sessions/sess-stale.jsonl')
  })
})

describe('sessionForHarness', () => {
  const rec = (ref: Record<string, string>) => ({ ...ref, updatedAt: 'now' }) as never

  it('returns a record written by the same harness', () => {
    const codex = rec({ harness: 'codex', sessionId: 'thread-1' })
    expect(sessionForHarness(codex, 'codex')).toBe(codex)
  })

  it('rejects a record written by a different harness', () => {
    // Claude and Codex share the sessionId field, so this is the case that
    // would otherwise hand a Claude session id to resumeThread().
    expect(sessionForHarness(rec({ harness: 'claude', sessionId: 's-1' }), 'codex')).toBeUndefined()
    expect(sessionForHarness(rec({ harness: 'codex', sessionId: 't-1' }), 'claude')).toBeUndefined()
    expect(
      sessionForHarness(rec({ harness: 'pi', sessionFile: '/s.jsonl' }), 'codex')
    ).toBeUndefined()
    expect(sessionForHarness(rec({ harness: 'claude', sessionId: 's-1' }), 'pi')).toBeUndefined()
  })

  it('attributes untagged legacy records by their populated field', () => {
    // Records predating the harness tag: only pi and claude existed then.
    const legacyPi = rec({ sessionFile: '/sessions/a.jsonl' })
    const legacyClaude = rec({ sessionId: 'sess-legacy' })

    expect(sessionForHarness(legacyPi, 'pi')).toBe(legacyPi)
    expect(sessionForHarness(legacyClaude, 'claude')).toBe(legacyClaude)

    expect(sessionForHarness(legacyPi, 'claude')).toBeUndefined()
    expect(sessionForHarness(legacyClaude, 'pi')).toBeUndefined()
    // Codex postdates the untagged format, so no untagged record is ever its.
    expect(sessionForHarness(legacyClaude, 'codex')).toBeUndefined()
    expect(sessionForHarness(legacyPi, 'codex')).toBeUndefined()
  })

  it('returns undefined for a missing record', () => {
    expect(sessionForHarness(undefined, 'codex')).toBeUndefined()
  })
})

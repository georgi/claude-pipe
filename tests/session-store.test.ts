import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SessionStore } from '../src/core/session-store.js'

describe('SessionStore', () => {
  it('persists and reloads session records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'microclaw-test-'))
    const path = join(dir, 'sessions.json')

    const store = new SessionStore(path)
    await store.init()
    await store.set('telegram:123', 'sess-abc')

    const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<string, { sessionId: string }>
    expect(raw['telegram:123']?.sessionId).toBe('sess-abc')

    const reloaded = new SessionStore(path)
    await reloaded.init()
    expect(reloaded.get('telegram:123')?.sessionId).toBe('sess-abc')
  })

  it('clears an existing session record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'microclaw-test-'))
    const path = join(dir, 'sessions.json')

    const store = new SessionStore(path)
    await store.init()
    await store.set('telegram:123', 'sess-abc')
    await store.clear('telegram:123')

    expect(store.get('telegram:123')).toBeUndefined()

    const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<string, { sessionId: string }>
    expect(raw['telegram:123']).toBeUndefined()
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MemoryStore } from '../src/memory/store.js'

describe('MemoryStore', () => {
  let dir: string
  let store: MemoryStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pi-pipe-memory-'))
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
    store.save('project_x', 'has 3 services', { service_count: 3, owner: 'alice' })

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

  it('lists all keys sorted', () => {
    store.save('b', 'second')
    store.save('a', 'first')
    store.save('c', 'third')

    expect(store.list()).toEqual(['a', 'b', 'c'])
  })

  it('filters list by prefix', () => {
    store.save('user_lang', 'x')
    store.save('user_tz', 'y')
    store.save('project_a', 'z')

    expect(store.list('user_')).toEqual(['user_lang', 'user_tz'])
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

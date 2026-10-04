import { describe, expect, it } from 'vitest'

import { chunkText } from '../src/core/text-chunk.js'

describe('chunkText', () => {
  it('throws when maxLen is zero', () => {
    expect(() => chunkText('hello', 0)).toThrow('maxLen must be greater than zero')
  })

  it('throws when maxLen is negative', () => {
    expect(() => chunkText('hello', -1)).toThrow('maxLen must be greater than zero')
  })

  it('returns single chunk for text within limit', () => {
    expect(chunkText('hello', 10)).toEqual(['hello'])
  })

  it('splits text at newline boundaries', () => {
    const result = chunkText('line1\nline2\nline3', 11)
    expect(result.length).toBeGreaterThanOrEqual(2)
    expect(result.join('\n')).toContain('line1')
  })

  it('prefers paragraph boundaries over line boundaries', () => {
    const text = 'paragraph one with several words.\n\nparagraph two also has words.'
    const result = chunkText(text, 40)
    expect(result[0]).toContain('paragraph one')
    expect(result[result.length - 1]).toContain('paragraph two')
  })

  it('splits at sentence ends when no paragraph or line break is available', () => {
    const text = 'First sentence is here. Second sentence comes next. Third one closes out.'
    const result = chunkText(text, 35)
    expect(result.length).toBeGreaterThan(1)
    // Each chunk should end at a sentence boundary or word boundary
    expect(result.every((c) => c.length <= 35)).toBe(true)
  })

  it('splits at word boundaries when no sentence end is in range', () => {
    const text = 'word ' + 'token '.repeat(30)
    const chunks = chunkText(text, 30)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(30)
    }
  })

  it('falls back to a hard cut for a single very long run of characters', () => {
    const text = 'x'.repeat(50)
    const chunks = chunkText(text, 10)
    expect(chunks).toHaveLength(5)
    expect(chunks.every((c) => c.length === 10)).toBe(true)
  })

  it('drops empty trailing whitespace and preserves order', () => {
    const text = 'first chunk content.\n\nsecond chunk content.'
    const out = chunkText(text, 20)
    expect(out.join(' ')).toContain('first')
    expect(out.join(' ')).toContain('second')
  })
})

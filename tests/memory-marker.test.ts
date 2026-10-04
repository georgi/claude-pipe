import { describe, expect, it } from 'vitest'

import { parseMemoryMarker } from '../src/memory/marker.js'

describe('parseMemoryMarker', () => {
  it('parses a simple key|content marker', () => {
    expect(parseMemoryMarker('user_pref|likes terse replies')).toEqual({
      key: 'user_pref',
      content: 'likes terse replies',
      opts: {}
    })
  })

  it('keeps pipes that are part of the content', () => {
    expect(parseMemoryMarker('shell_tip|use a | b to pipe')?.content).toBe('use a | b to pipe')
  })

  it('reads trailing metadata segments', () => {
    expect(
      parseMemoryMarker(
        'yasmin_bday|Birthday is 3 May|type:fact|entity:person:yasmin|entity:location:berlin|confidence:high'
      )
    ).toEqual({
      key: 'yasmin_bday',
      content: 'Birthday is 3 May',
      opts: {
        type: 'fact',
        entityTags: ['person:yasmin', 'location:berlin'],
        confidence: 'high'
      }
    })
  })

  it('treats unknown prefixes as content', () => {
    expect(parseMemoryMarker('k|time is 10:30|note:keep')).toEqual({
      key: 'k',
      content: 'time is 10:30|note:keep',
      opts: {}
    })
  })

  it('never consumes the content itself as metadata', () => {
    expect(parseMemoryMarker('k|type:fact')).toEqual({ key: 'k', content: 'type:fact', opts: {} })
  })

  it('returns null without key or content', () => {
    expect(parseMemoryMarker('|content')).toBeNull()
    expect(parseMemoryMarker('key|')).toBeNull()
    expect(parseMemoryMarker('key')).toBeNull()
  })
})

import type { SaveOptions } from './store.js'

export interface ParsedMemoryMarker {
  key: string
  content: string
  opts: SaveOptions
}

const META_PREFIXES = new Set(['type', 'entity', 'confidence'])

/**
 * Parses the body of a `[[memory:...]]` marker (everything after `memory:`).
 *
 *   key|content
 *   key|content|type:fact|entity:person:yasmin|confidence:high
 *
 * Only trailing segments with a known `prefix:` count as metadata, so content
 * that itself contains `|` is kept intact. Returns null without key or content.
 */
export function parseMemoryMarker(body: string): ParsedMemoryMarker | null {
  const [rawKey, ...segments] = body.split('|')
  const key = rawKey?.trim() ?? ''

  const opts: SaveOptions = {}
  const entityTags: string[] = []
  while (segments.length > 1) {
    const last = segments[segments.length - 1]!.trim()
    const sep = last.indexOf(':')
    const prefix = sep > 0 ? last.slice(0, sep) : ''
    const value = last.slice(sep + 1).trim()
    if (!META_PREFIXES.has(prefix) || !value) break
    segments.pop()

    if (prefix === 'type') opts.type ??= value
    else if (prefix === 'confidence') opts.confidence ??= value
    else entityTags.unshift(value)
  }
  if (entityTags.length > 0) opts.entityTags = entityTags

  const content = segments.join('|').trim()
  if (!key || !content) return null
  return { key, content, opts }
}

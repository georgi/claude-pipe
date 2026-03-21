/**
 * Splits text into chunks not exceeding `maxLen`.
 *
 * Split priority (best to worst):
 * 1. Double newline (paragraph boundary)
 * 2. Single newline (line boundary)
 * 3. Sentence end (. ! ?) followed by space
 * 4. Space (word boundary)
 * 5. Hard cut at maxLen (last resort)
 */
export function chunkText(text: string, maxLen: number): string[] {
  if (maxLen <= 0) throw new Error('maxLen must be greater than zero')
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxLen) {
    const splitAt = findBestSplit(remaining, maxLen)
    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }

  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

function findBestSplit(text: string, maxLen: number): number {
  const window = text.slice(0, maxLen)

  // 1. Paragraph boundary (double newline)
  const para = window.lastIndexOf('\n\n')
  if (para > maxLen * 0.3) return para + 1

  // 2. Line boundary (single newline)
  const line = window.lastIndexOf('\n')
  if (line > maxLen * 0.3) return line + 1

  // 3. Sentence end followed by space
  const sentenceEnd = findLastSentenceEnd(window)
  if (sentenceEnd > maxLen * 0.3) return sentenceEnd

  // 4. Word boundary (space)
  const space = window.lastIndexOf(' ')
  if (space > maxLen * 0.3) return space + 1

  // 5. Hard cut
  return maxLen
}

/** Finds the last sentence-ending position (after . ! ? followed by space or newline). */
function findLastSentenceEnd(text: string): number {
  let best = -1
  for (let i = text.length - 1; i >= 1; i--) {
    const ch = text[i]
    if (ch === ' ' || ch === '\n') {
      const prev = text[i - 1]
      if (prev === '.' || prev === '!' || prev === '?') {
        best = i + 1
        break
      }
    }
  }
  return best
}

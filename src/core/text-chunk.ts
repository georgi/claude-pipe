/**
 * Splits text into chunks not exceeding `maxLen`.
 * Prefers newline boundaries when available.
 */
export function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen)
    if (splitAt <= 0) splitAt = maxLen

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

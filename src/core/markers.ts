import type { FileAttachment, InlineKeyboard } from './types.js'

/**
 * Markers the model can embed in its text response to trigger side effects:
 *
 * - `[[file:/path/to/file.ext]]` or `[[file:/path|caption]]` — attach a file.
 * - `[[keyboard:Label=data,Label2=data2|Label3=data3]]` — inline keyboard
 *   (pipe separates rows, comma separates buttons within a row).
 * - `[[memory:key|content to remember]]` — persist a memory entry.
 *
 * Parsing lives here (rather than inline in the agent loop) so it can be unit
 * tested in isolation and the loop stays focused on orchestration.
 */

const FILE_MARKER = /\[\[file:([^|\]]+?)(?:\|([^\]]*))?\]\]/g
const KEYBOARD_MARKER = /\[\[keyboard:([^\]]+)\]\]/g
const MEMORY_MARKER = /\[\[memory:([^|]+)\|([^\]]+)\]\]/g

/** Telegram limits inline-button `callback_data` to 64 bytes. */
const MAX_CALLBACK_DATA = 64

export interface ParsedMemory {
  key: string
  value: string
}

export interface ParsedMarkers {
  /** Response text with every marker removed and trimmed. */
  text: string
  attachments: FileAttachment[]
  keyboard?: InlineKeyboard
  memories: ParsedMemory[]
}

export interface ParseMarkerOptions {
  /** Gate for file attachments (e.g. workspace containment). Defaults to allow-all. */
  allowAttachment?: (filePath: string) => boolean
  /** Invoked when a file marker is rejected by {@link allowAttachment}. */
  onAttachmentBlocked?: (filePath: string) => void
}

/**
 * Extracts file / keyboard / memory markers from a model response and returns
 * the cleaned text alongside the structured side effects. The caller is
 * responsible for acting on them (sending files, persisting memories, etc.).
 */
export function parseMarkers(raw: string, options: ParseMarkerOptions = {}): ParsedMarkers {
  const attachments: FileAttachment[] = []
  const memories: ParsedMemory[] = []
  let keyboard: InlineKeyboard | undefined

  let text = raw.replace(FILE_MARKER, (_match, filePath: string, caption?: string) => {
    const trimmedPath = filePath.trim()
    if (options.allowAttachment && !options.allowAttachment(trimmedPath)) {
      options.onAttachmentBlocked?.(trimmedPath)
      return ''
    }
    const trimmedCaption = caption?.trim()
    attachments.push({
      filePath: trimmedPath,
      ...(trimmedCaption ? { caption: trimmedCaption } : {})
    })
    return ''
  })

  text = text.replace(KEYBOARD_MARKER, (_match, spec: string) => {
    keyboard = spec.split('|').map((row: string) =>
      row.split(',').map((btn: string) => {
        const parts = btn.split('=')
        const label = (parts[0] ?? '').trim()
        const data = (parts.length > 1 ? parts.slice(1).join('=') : label).trim()
        return { text: label, callbackData: data.slice(0, MAX_CALLBACK_DATA) }
      })
    )
    return ''
  })

  text = text.replace(MEMORY_MARKER, (_match, key: string, value: string) => {
    memories.push({ key: key.trim(), value: value.trim() })
    return ''
  })

  return {
    text: text.trim(),
    attachments,
    memories,
    ...(keyboard ? { keyboard } : {})
  }
}

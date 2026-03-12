import type { Logger } from './types.js'

export type LogLevel = 'verbose' | 'status' | 'off'

let muted = false
let minLevel: LogLevel = 'verbose'

const levelPriority: Record<'INFO' | 'WARN' | 'ERROR', number> = {
  INFO: 0,
  WARN: 1,
  ERROR: 2
}

export function setLoggerMuted(value: boolean): void {
  muted = value
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level
  muted = level === 'off'
}

function emit(level: 'INFO' | 'WARN' | 'ERROR', event: string, data?: Record<string, unknown>): void {
  if (muted) return
  if (minLevel === 'status' && levelPriority[level] < levelPriority.WARN) return
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(data ?? {})
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload))
}

/** Simple JSON logger used across runtime modules. */
export const logger: Logger = {
  info(event, data) {
    emit('INFO', event, data)
  },
  warn(event, data) {
    emit('WARN', event, data)
  },
  error(event, data) {
    emit('ERROR', event, data)
  }
}

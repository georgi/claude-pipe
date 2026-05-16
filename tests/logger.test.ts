import { afterEach, describe, expect, it, vi } from 'vitest'

import { logger, setLoggerMuted } from '../src/core/logger.js'

describe('logger', () => {
  afterEach(() => {
    setLoggerMuted(false)
    vi.restoreAllMocks()
  })

  it('emits INFO level events as JSON to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    logger.info('test.event', { foo: 'bar' })

    expect(spy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string)
    expect(parsed.level).toBe('INFO')
    expect(parsed.event).toBe('test.event')
    expect(parsed.foo).toBe('bar')
    expect(parsed.ts).toBeTruthy()
  })

  it('emits WARN level events', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    logger.warn('warn.event')

    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string)
    expect(parsed.level).toBe('WARN')
    expect(parsed.event).toBe('warn.event')
  })

  it('emits ERROR level events', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    logger.error('boom', { code: 500 })

    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string)
    expect(parsed.level).toBe('ERROR')
    expect(parsed.code).toBe(500)
  })

  it('suppresses output when muted', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    setLoggerMuted(true)
    logger.info('hidden')
    logger.warn('hidden')
    logger.error('hidden')
    expect(spy).not.toHaveBeenCalled()
  })
})

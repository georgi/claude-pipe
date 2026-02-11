import { describe, expect, it, vi } from 'vitest'

import { logger, setLoggerMuted } from '../src/core/logger.js'

describe('logger mute', () => {
  it('suppresses output when muted', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    setLoggerMuted(true)
    logger.info('test.event', { ok: true })
    expect(spy).not.toHaveBeenCalled()
    setLoggerMuted(false)
    spy.mockRestore()
  })
})

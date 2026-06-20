import { describe, it, expect } from 'vitest'
import { RateLimiter } from '../src/core/rate-limiter.js'

describe('RateLimiter', () => {
  it('allows events up to the limit then blocks', () => {
    const rl = new RateLimiter(3, 1000)
    expect(rl.allow('a', 0)).toBe(true)
    expect(rl.allow('a', 10)).toBe(true)
    expect(rl.allow('a', 20)).toBe(true)
    expect(rl.allow('a', 30)).toBe(false)
  })

  it('tracks keys independently', () => {
    const rl = new RateLimiter(1, 1000)
    expect(rl.allow('a', 0)).toBe(true)
    expect(rl.allow('b', 0)).toBe(true)
    expect(rl.allow('a', 1)).toBe(false)
  })

  it('frees capacity once events fall outside the window', () => {
    const rl = new RateLimiter(2, 1000)
    expect(rl.allow('a', 0)).toBe(true)
    expect(rl.allow('a', 500)).toBe(true)
    expect(rl.allow('a', 900)).toBe(false)
    // The first event (t=0) is now outside the 1000ms window.
    expect(rl.allow('a', 1001)).toBe(true)
  })

  it('does not consume capacity when blocking', () => {
    const rl = new RateLimiter(1, 1000)
    expect(rl.allow('a', 0)).toBe(true)
    expect(rl.allow('a', 100)).toBe(false)
    expect(rl.allow('a', 200)).toBe(false)
    // Once the original event expires, a new one is allowed.
    expect(rl.allow('a', 1001)).toBe(true)
  })
})

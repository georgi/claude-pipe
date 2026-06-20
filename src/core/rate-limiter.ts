/**
 * Sliding-window rate limiter keyed by an arbitrary string (e.g. sender id).
 *
 * Keeps the timestamps of recent allowed events per key and rejects once a key
 * exceeds `maxEvents` within `windowMs`. Old timestamps are pruned lazily on
 * each call, so memory stays bounded by the number of recently active keys.
 */
export class RateLimiter {
  private readonly events = new Map<string, number[]>()

  constructor(
    private readonly maxEvents: number,
    private readonly windowMs: number
  ) {}

  /**
   * Records an event for `key` and returns true if it is within the limit.
   * Returns false (and does not record) when the key is over its limit.
   */
  allow(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs
    const recent = (this.events.get(key) ?? []).filter((t) => t > cutoff)

    if (recent.length >= this.maxEvents) {
      this.events.set(key, recent)
      return false
    }

    recent.push(now)
    this.events.set(key, recent)
    return true
  }
}

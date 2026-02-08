export interface RetryOptions {
  attempts: number
  backoffMs: number
}

/**
 * Retries an async operation with fixed backoff.
 */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt < options.attempts) {
        await new Promise((resolve) => setTimeout(resolve, options.backoffMs))
      }
    }
  }

  throw lastError
}

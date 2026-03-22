/**
 * Stub — full implementation lives on feat/memory-store.
 *
 * Appends timestamped entries to daily markdown log files.
 */
export class DailyLog {
  constructor(_logDir: string) {}

  async append(_conversationKey: string, _role: 'user' | 'assistant', _text: string): Promise<void> {
    // stub
  }

  async getToday(): Promise<string> {
    return ''
  }

  async getRecent(_days: number): Promise<string> {
    return ''
  }
}

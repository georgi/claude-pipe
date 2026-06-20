import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        // Pure type/interface declarations (no executable code).
        'src/core/types.ts',
        'src/core/model-client.ts',
        // Re-export barrels with no logic.
        'src/memory/index.ts',
        'src/commands/types.ts',
        // The main entrypoint — exercised end-to-end through integration runs,
        // not unit tests. It would require booting every subsystem.
        'src/index.ts'
      ],
      reporter: ['text', 'html'],
      // Guardrails against coverage regressions. Set a little below current
      // levels (~92% stmts / ~85% branch) so normal churn doesn't trip CI but
      // a meaningful drop does.
      thresholds: {
        statements: 88,
        branches: 80,
        functions: 92,
        lines: 88
      }
    }
  }
})

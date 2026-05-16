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
        'src/index.ts',
      ],
      reporter: ['text', 'html'],
    },
  },
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Both modules resolve their data paths once, at module scope, from env vars. Each
    // test file therefore has to own its own process: a fork per file, no shared module
    // registry, so one file's temp workspace can't leak into another's.
    pool: 'forks',
    isolate: true,
    fileParallelism: true,
    testTimeout: 20_000,
    // test/e2e is Playwright's (see playwright.config.ts) — it drives a real browser
    // against a real server and has nothing to do with the in-process suite.
    exclude: ['node_modules/**', 'test/e2e/**'],
  },
})

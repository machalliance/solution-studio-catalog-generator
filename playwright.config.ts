import { defineConfig, devices } from '@playwright/test'

// The UI is a single 3.4k-line HTML file with all of its JS inline, so there is nothing
// importable to unit-test — a real browser is the only way to cover it. These specs drive
// the app end to end against a real server and a real (temporary) catalog on disk.
//
// The server under test is started by the webServer block below unless BASE_URL points
// somewhere else, which is how you run these against an already-running container.
const PORT = process.env.E2E_PORT ?? '3010'
const DATA_ROOT = process.env.E2E_APP_ROOT ?? '/tmp/catgen-e2e'

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,          // one server, one catalog on disk — specs share state
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 7_500 },

  use: {
    baseURL: process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // Skipped when BASE_URL is set, so the same specs can be pointed at a container that
  // is already up (docker compose up -d) instead of starting a throwaway one.
  webServer: process.env.BASE_URL ? undefined : {
    command: `rm -rf ${DATA_ROOT} && mkdir -p ${DATA_ROOT}/data/catalog ${DATA_ROOT}/data/images && npx tsx src/server.ts`,
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT,
      // A throwaway data directory, and no API keys — every LLM-backed control in the UI
      // is expected to fail loudly here, and no spec depends on one succeeding.
      APP_ROOT: DATA_ROOT,
      CONFIG_PATH: `${DATA_ROOT}/config.json`,
      SITES_PATH: `${DATA_ROOT}/sites.json`,
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      STUDIO_API_TOKEN: '',
    },
  },
})

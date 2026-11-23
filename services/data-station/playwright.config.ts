import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4318',
    headless: true,
    launchOptions: { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node dist-server/main.js',
    url: 'http://127.0.0.1:4318/api/health',
    reuseExistingServer: false,
    env: { MUSE_DATA_PORT: '4318', MUSE_DATA_MODE: 'local-preview', MUSE_DATA_DIRECTORY: `${process.cwd()}/.data/browser-test-${process.pid}`, MUSE_DATA_AUTO_COLLECT: '0' },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    timeout: 60_000,
  },
});

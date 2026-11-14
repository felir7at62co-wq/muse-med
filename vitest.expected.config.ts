import { availableParallelism } from 'node:os'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

/** Owner-local assembled expected-output tests that do not use a recorded session as their input. */
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    env: { DSH_EXAMPLE_MODE: 'lib' },
    setupFiles: ['./scripts/test-proxy-environment.ts'],
    include: [
      'apps/cli/tests/**/*.expected.e2e.ts',
      'apps/desktop-host/tests/**/*.expected.e2e.ts',
      'apps/desktop-host/tests/hongguo-public-download-loader.spec.ts',
      'apps/desktop-host/tests/hongguo-search-loader.spec.ts',
      'apps/desktop-host/tests/manuscript-repetition-loader.spec.ts',
      'apps/desktop-host/tests/manuscript-revision-basis.spec.ts',
      'apps/desktop-host/tests/manuscript-cross-episode-loader.spec.ts',
      'apps/desktop-host/tests/manuscript-ptc-delivery.spec.ts',
      'apps/desktop-host/tests/manuscript-continuity-submission.spec.ts',
      'apps/desktop-host/tests/manuscript-notes-loader.spec.ts',
      'apps/desktop-host/tests/manuscript-video-source-binding-loader.spec.ts',
      'apps/desktop-host/tests/manuscript-video-source-delivery.spec.ts',
    ],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    maxWorkers: Math.min(5, availableParallelism()),
  },
})

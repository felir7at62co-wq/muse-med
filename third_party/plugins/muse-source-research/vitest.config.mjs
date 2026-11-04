/** Source-mode filesystem tests reuse the repository's TypeScript resolution and decorator transform. */
import { fileURLToPath } from 'node:url';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';
import { standardDecoratorPlugin } from '../../../vitest.shared.ts';

const root = fileURLToPath(new URL('./', import.meta.url));
export default defineConfig({
  root,
  plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../../../tsconfig.base.json', import.meta.url))], loose: true }), standardDecoratorPlugin()],
  test: { include: ['tests/*.test.js'], pool: 'forks' },
});

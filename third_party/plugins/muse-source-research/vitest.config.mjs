/** Source-mode filesystem tests reuse the repository's TypeScript resolution and decorator transform. */
import { fileURLToPath } from 'node:url';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';
import { standardDecoratorPlugin } from '../../../vitest.shared.ts';

const root = fileURLToPath(new URL('./', import.meta.url));
export default defineConfig({
  root,
  resolve: { alias: [
    { find: /^muse-hongguo-search\/client$/, replacement: fileURLToPath(new URL('../muse-hongguo-search/src/client.js', import.meta.url)) },
    { find: /^muse-qimao-data\/client$/, replacement: fileURLToPath(new URL('../muse-qimao-data/src/client.js', import.meta.url)) },
  ] },
  plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../../../tsconfig.base.json', import.meta.url))], loose: true }), standardDecoratorPlugin()],
  test: { include: ['tests/*.test.js'], pool: 'forks' },
});

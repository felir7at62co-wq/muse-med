/** Keyless project commands through the supported Headless app and real agent loop. */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { PROJECT_FILE } from '../src/schema.ts'

it('loads the tool, logs its canonical source result, and rejects self approval through the agent loop', async () => {
  const patch = fileURLToPath(new URL('./fixtures/cordis.yml', import.meta.url))
  const { stderr } = await runLoaderSmoke({
    label: 'screenplay project Headless', tempDirPrefix: 'screenplay-loader-',
    binScript: fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url)),
    configPath: patch, binArgs: ['--profile', 'headless', '--patch', patch, '--json', '执行来源录入并尝试自审。'],
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    sourceImport: 'tsx/esm', mode: 'src',
    prepare: async (cwd) => { await writeFile(join(cwd, 'source.txt'), '甲想：钥匙在我手里。\n') },
    inspect: async (cwd) => {
      const project = PROJECT_FILE.parse(JSON.parse(await readFile(join(cwd, 'project.json'), 'utf8')))
      expect(project.facts).toHaveLength(1)
      expect(project.facts[0]!.review).toBeUndefined()
      expect(project.accepted).toEqual([])
      const names = await readdir(join(cwd, '.sessions'), { recursive: true })
      const logs = await Promise.all(names.filter(name => name.endsWith('.jsonl')).map(name => readFile(join(cwd, '.sessions', name), 'utf8')))
      const text = logs.join('\n')
      expect(text).toContain('self_review')
      expect(text).toContain('甲想：钥匙在我手里。')
      expect(text).toContain('source_sha256')
      expect(text).toContain('screenplay_project')
    },
  })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

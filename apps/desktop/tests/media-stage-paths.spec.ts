import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { shortStage } from '../scripts/media-resources.ts'

// Windows fails to load an extension module whose dependency resolution passes
// MAX_PATH, and numba's `_typeconv` inside the BGM payload is deep enough that a
// staging directory under `.desktop-build` already pushed it over the limit.
const STAGE_PATH_LIMIT = 60

it('stages a deep output on the same volume without inheriting the output depth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-stage-'))
  const deep = join(root, 'nested'.repeat(8), 'deeper'.repeat(8), 'media')
  await mkdir(dirname(deep), { recursive: true })
  let stage: string | undefined
  try {
    stage = await shortStage(deep)
    expect((await stat(stage)).isDirectory()).toBe(true)
    expect(parse(stage).root).toBe(parse(deep).root)
    expect(stage.length).toBeLessThanOrEqual(STAGE_PATH_LIMIT)
    expect(stage.length).toBeLessThan(deep.length)
  } finally {
    if (stage !== undefined) await rm(stage, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

it('routes both payload preparers through the short staging helper', async () => {
  for (const name of ['prepare-media-runtime.ts', 'prepare-bgm-runtime.ts']) {
    const source = await readFile(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), 'utf8')
    expect(source, name).toContain('shortStage(')
    expect(source, name).not.toMatch(/\$\{output\}\.\$\{randomUUID\(\)\}\.preparing/u)
  }
})

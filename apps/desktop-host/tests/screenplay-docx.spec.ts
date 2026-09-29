/** Screenplay conversion preserves source order and never replaces an existing deliverable. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { exportScreenplayDocx } from '../src/screenplay-docx.ts'

it('refuses a missing source before resolving the bundled runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'screenplay-docx-'))
  try {
    await expect(exportScreenplayDocx({ inputs: [join(root, 'missing.md')], output: join(root, '剧本.docx') },
      { source: join(root, 'runtime'), maxInputBytes: 1000, timeoutMs: 1000 })).rejects.toThrow()
    await writeFile(join(root, '剧本.docx'), 'existing')
    await writeFile(join(root, '剧本.md'), '第1集')
    await expect(exportScreenplayDocx({ inputs: [join(root, '剧本.md')], output: join(root, '剧本.docx') },
      { source: join(root, 'runtime'), maxInputBytes: 1000, timeoutMs: 1000 })).rejects.toThrow('already exists')
    expect(await readFile(join(root, '剧本.docx'), 'utf8')).toBe('existing')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


it.skipIf(!process.env.MUSE_TEST_PRIMARY_RUNTIME)('exports ordered Chinese Markdown using the packaged runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'screenplay-docx-runtime-'))
  try {
    const first = join(root, '第1集.md')
    const second = join(root, '第2集.md')
    const output = join(root, '完整剧本.docx')
    await writeFile(first, '# 第1集\n1-1 老屋 夜 内\n人物：林遥、周宁\n▲林遥放下信。\n林遥 OS：不能告诉他。\n周宁：你怎么了？\n林遥：没事。\n')
    await writeFile(second, '# 第2集\n2-1 门口 日 外\n人物：林遥\n▲林遥推开门。\n**【下集钩子】**\n林遥：是你？\n')
    expect(await exportScreenplayDocx({ inputs: [first, second], output }, {
      source: process.env.MUSE_TEST_PRIMARY_RUNTIME!, maxInputBytes: 10000, timeoutMs: 30000,
    })).toEqual({ output })
    const bytes = await readFile(output)
    expect(bytes.subarray(0, 2).toString()).toBe('PK')
    expect(bytes.length).toBeGreaterThan(1000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

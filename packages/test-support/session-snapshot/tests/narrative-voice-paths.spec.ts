/** Recorded workspace paths retain their meaning on native Windows and POSIX executors. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { rebindNarrativeVoicePaths } from '../../../../snapshots/session/muse-narrative-voice/replay-paths.mjs'

it('rebinds only declared path fields under a complete POSIX workspace prefix', () => {
  const cwd = '/isolated/workspace'
  const content = `${cwd}\\fictional-line.txt：温雨OS：我要是喊出来，周明就会冲进来。`
  const args = Object.freeze({ script: `${cwd}\\director.txt`, assets: `${cwd}\\assets_manifest.json`, project: cwd,
    method: 'compile', content, nested: { script: `${cwd}\\business-text` } })
  expect(rebindNarrativeVoicePaths('drama_shot', args, cwd)).toEqual({ ...args,
    script: `${cwd}/director.txt`, assets: `${cwd}/assets_manifest.json` })
  expect(args.script).toBe(`${cwd}\\director.txt`)
  expect(args.content).toBe(content)
})

it('retains native Windows paths and leaves unrelated tools and external paths untouched', () => {
  const cwd = 'C:\\isolated\\workspace'
  const args = { file_path: `${cwd}/shot_reviews/01/review.json`, content: '原台词不改' }
  expect(rebindNarrativeVoicePaths('read', args, cwd)).toEqual({ ...args, file_path: `${cwd}\\shot_reviews\\01\\review.json` })
  expect(rebindNarrativeVoicePaths('other_tool', args, cwd)).toBe(args)
  for (const file_path of [`${cwd}-other\\director.txt`, 'D:\\external\\director.txt', 'relative\\director.txt']) {
    expect(rebindNarrativeVoicePaths('write', { ...args, file_path }, cwd)).toEqual({ ...args, file_path })
  }
})

it('rejects traversal and ambiguous segments inside the bound workspace prefix', () => {
  const cwd = '/isolated/workspace'
  for (const suffix of ['..\\outside.txt', '.\\director.txt', 'shot_reviews\\\\01.txt', 'bad\0name']) {
    expect(() => rebindNarrativeVoicePaths('read', { file_path: `${cwd}\\${suffix}` }, cwd)).toThrow('beneath the bound workspace')
  }
})

it('performs real native file I/O without changing the recorded path or content', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-narrative-native-path-'))
  try {
    const args = Object.freeze({ file_path: `${cwd}\\director.txt`, content: '温雨OS：今天不能出错。' })
    const native = rebindNarrativeVoicePaths('write', args, cwd)
    if (!native || typeof native !== 'object' || !('file_path' in native) || typeof native.file_path !== 'string'
      || !('content' in native) || typeof native.content !== 'string') throw new Error('Expected native write arguments')
    await writeFile(native.file_path, native.content)
    expect(await readFile(join(cwd, 'director.txt'), 'utf8')).toBe(args.content)
    await writeFile(native.file_path, '温雨（低声说）：今天不能出错。')
    expect(await readFile(native.file_path, 'utf8')).not.toBe(args.content)
    expect(args.file_path).toBe(`${cwd}\\director.txt`)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

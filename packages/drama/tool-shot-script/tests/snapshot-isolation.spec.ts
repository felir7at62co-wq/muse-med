/** Compiler replay fixtures isolate unrelated skills while retaining real filesystem paths. */
import { cp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { call, cleanup, tempDir } from './harness.ts'

const cases = [
  { name: 'muse-shot-scene-context', negative: 'shots-context-only.txt', maximum: 15 },
  { name: 'muse-shot-derived-visual', negative: 'shots-invalid.txt', maximum: 30 },
] as const

describe.each(cases)('$name replay isolation', ({ name, negative, maximum }) => {
  const fixture = new URL(`../../../../snapshots/session/${name}/`, import.meta.url)

  it('keeps skills outside the compiler composition without disabling the sandbox', async () => {
    const config = await readFile(new URL('cordis.yml', fixture), 'utf8')
    expect(await readFile(new URL('cordis.snapshot.yml', fixture), 'utf8')).toBe(config)
    expect(config).toMatch(/\n- id: tool-skill\r?\n  disabled: true(?:\r?\n|$)/)
    expect(config).not.toMatch(/\n- id: sandbox\r?\n  disabled: true(?:\r?\n|$)/)
    expect(config).toContain('../../../packages/drama/tool-shot-script/tests/snapshot-plugin.mjs')
  })

  it('preserves positive and negative compiler results across native and POSIX path spelling', async () => {
    const root = await tempDir()
    try {
      await cp(new URL('workspace/', fixture), root, { recursive: true })
      const original = await readFile(join(root, 'shots.txt'), 'utf8')
      const preview = async (script: string, posix: boolean) => {
        const spelling = (path: string) => posix ? path.replaceAll('\\', '/') : path
        return await call({ method: 'preview', script: spelling(join(root, script)),
          assets: spelling(join(root, 'assets_manifest.json')), project: spelling(root),
          episode: 1, max_submit_seconds: maximum })
      }
      const positive = await preview('shots.txt', false)
      expect(positive).toMatchObject({ ok: true, failures: [], written: [] })
      expect(await preview('shots.txt', true)).toEqual(positive)
      expect(positive.script).toBe(join(root, 'shots.txt'))
      expect(positive.assets_manifest).toBe(join(root, 'assets_manifest.json'))
      const refused = await preview(negative, false)
      expect(await preview(negative, true)).toEqual(refused)
      if (name === 'muse-shot-scene-context') {
        expect(refused).toMatchObject({ ok: true, written: [], shots: [{ bindings: [] }] })
        expect(refused.packages[0]?.material_bindings).toEqual([])
        expect(refused.warnings).toContainEqual(expect.objectContaining({ code: 'no_scene_bound' }))
      } else {
        expect(refused).toMatchObject({ ok: false, packages: [], written: [] })
        expect(refused.failures.length).toBeGreaterThan(0)
      }
      expect(await readFile(join(root, 'shots.txt'), 'utf8')).toBe(original)
    } finally {
      await cleanup(root)
    }
  })
})

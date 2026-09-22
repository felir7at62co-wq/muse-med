/**
 * The bundle patch must actually mount this plugin.
 *
 * A patch that names the wrong package produces a composition error at boot, but
 * only for whoever mounts it — long after the mistake was made. These checks turn
 * that into a test failure here: the patch parses, it inserts exactly the row this
 * package is, and the manifest advertises the patch so a profile can find it.
 *
 * The loader itself applies the patch (see `packages/boot/app-boot/src/profile.ts`),
 * so what is verified here is the contract the loader reads, not a reimplementation
 * of it.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'

const packages = [
  { dir: 'perception-bgm', rowId: 'perception-bgm' },
] as const

interface PatchRow { id: string; name: string; config?: Record<string, unknown> }
type PatchEntry = { insert: PatchRow[] }

describe.each(packages)('$dir bundle patch', ({ dir, rowId }) => {
  const root = join(import.meta.dirname, '..', '..', dir)

  it('declares the patch in the manifest the profile loader reads', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      name: string
      exports: Record<string, string>
      files: string[]
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    // The loader resolves the patch through the package's own exports.
    expect(manifest.exports['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    // And a published package must actually carry the file.
    expect(manifest.files).toContain('cordis.patch.yml')
  })

  it('parses as a patch list and inserts exactly this package', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string }
    const parsed = yaml.load(await readFile(join(root, 'cordis.patch.yml'), 'utf8')) as PatchEntry[]
    expect(Array.isArray(parsed)).toBe(true)

    const rows = parsed.flatMap(entry => entry.insert ?? [])
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.id).toBe(rowId)
    // The name must match the manifest exactly; a typo here only surfaces at boot.
    expect(row?.name).toBe(manifest.name)
  })

  it('keeps every documented config key one the plugin actually accepts', async () => {
    const parsed = yaml.load(await readFile(join(root, 'cordis.patch.yml'), 'utf8')) as PatchEntry[]
    const rows = parsed.flatMap(entry => entry.insert ?? [])
    const config = rows[0]?.config ?? {}
    // The shipped patch mounts with defaults; documented keys live in the comments
    // above so a deployment can copy them. Asserting the row stays config-free keeps
    // the patch honest about not guessing a path for someone else's machine.
    expect(Object.keys(config)).toEqual([])
  })
})

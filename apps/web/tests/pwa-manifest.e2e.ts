import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships muse-med install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')
  expect(index).toContain('<title>muse-med</title>')
  expect(index).toContain('<link rel="icon" type="image/webp" href="./muse-med-logo-black.webp" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  // No `id`: a browser resolves an explicit `id` against the start URL's origin,
  // so only an absent `id`, which defaults to the resolved `start_url`, gives
  // each mount its own identity. `public-mount.e2e.ts` reads the resolved form.
  expect(manifest).toEqual({
    name: 'muse-med',
    short_name: 'muse-med',
    start_url: './',
    scope: './',
    display: 'fullscreen',
    icons: [{
      src: 'muse-med-logo.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    }],
  })
})

it('ships fixed-color favicons selected by document media queries', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />')
  const light = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  const dark = await readFile(join(DIST_ROOT, 'favicon-dark.svg'), 'utf8')
  expect(light).not.toContain('<style>')
  expect(light).toContain('fill="#000"')
  expect(dark).toContain('fill="#fff"')
  expect(dark.replace('fill="#fff"', 'fill="#000"')).toBe(light)
})

it.each([
  ['black', 'f0cab392cf02a8aaafbdb99726f6d216d2dbe98881cc0ab23306e99f2d7ce5b3'],
  ['white', 'af3c79dde01f53915575602c8b4ee6547d21793b9828d4e6651787c97e3dc65a'],
])('ships the original %s theme artwork without transforming it', async (color, hash) => {
  const logo = await readFile(join(DIST_ROOT, `muse-med-logo-${color}.webp`))
  expect(createHash('sha256').update(logo).digest('hex')).toBe(hash)
})

it('keeps the install icon as a square PNG', async () => {
  const logo = await readFile(join(DIST_ROOT, 'muse-med-logo.png'))
  expect(logo.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(logo.readUInt32BE(16)).toBe(512)
  expect(logo.readUInt32BE(20)).toBe(512)
  expect(logo).toEqual(await readFile(join(DIST_ROOT, '../public/muse-med-logo.png')))
})

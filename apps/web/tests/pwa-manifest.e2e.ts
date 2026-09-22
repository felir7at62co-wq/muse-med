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
  expect(manifest).toEqual({
    id: '/', name: 'muse-med', short_name: 'muse-med', start_url: '/', scope: '/', display: 'fullscreen',
    icons: [{ src: '/muse-med-logo.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
  })
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

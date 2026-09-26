import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { productHomeFor } from '../src/product-home.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** One user home carrying the named product directories. */
async function userHome(...names: string[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'muse-product-home-'))
  temporary.push(home)
  for (const name of names) await mkdir(join(home, name))
  return home
}

it('starts on the current home when neither directory exists', async () => {
  const home = await userHome()

  expect(productHomeFor(home)).toBe(join(home, '.muse'))
})

it('keeps reading the pre-rename home so an installed copy keeps its data', async () => {
  const home = await userHome('.muse-med')

  expect(productHomeFor(home)).toBe(join(home, '.muse-med'))
})

it('prefers the current home once it exists', async () => {
  const home = await userHome('.muse-med', '.muse')

  expect(productHomeFor(home)).toBe(join(home, '.muse'))
})

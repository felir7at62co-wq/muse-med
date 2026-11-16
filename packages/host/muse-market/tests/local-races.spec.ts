/** Real concurrent cache mutation against the local reader's exact-bytes guards.
 *
 * Each guard below exists for a file that changes while it is being read. The tests
 * therefore mutate the same real file from a second handle while the public reader or
 * verifier is between its own path check, opened handle and re-read; every attempt is a
 * genuine filesystem race, never an injected or fabricated node:fs promise.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { appendFile, lstat, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MuseMarketLocal, readMarketBytes } from '../src/local.ts'
import { MarketError } from '../src/format.ts'
import { createMarketPackage } from '../src/package.ts'
import { directory, limits, manifest, resources } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

async function fixture() {
  const value = await directory(); cleanups.push(value.cleanup)
  const local = new MuseMarketLocal({ root: join(value.root, 'market'), limits })
  await local.ready()
  const scratch = join(value.root, 'settle-probe')
  await writeFile(scratch, 'x')
  return { ...value, local, scratch }
}

/** Yield through `operations` real filesystem round trips (~28us each here).
 * Timers on this platform resolve in ~15.6ms ticks, far too coarse to place a write
 * inside a read that lasts a few milliseconds.
 */
async function settle(scratch: string, operations: number): Promise<void> {
  for (let index = 0; index < operations; index += 1) await lstat(scratch)
}

/** Run one real mutation attempt until the reader refuses with `code`. */
async function refusedCode(attempt: () => Promise<unknown>, code: string, attempts = 24): Promise<MarketError> {
  const observed = new Set<string>()
  for (let index = 0; index < attempts; index += 1) {
    try { await attempt() } catch (error) {
      if (!(error instanceof MarketError)) throw error
      observed.add(error.code)
      if (error.code === code) return error
    }
  }
  throw new Error(`Never observed ${code} in ${attempts} attempts; observed [${[...observed].join(', ')}]`)
}

describe('local publication races', () => {
  it('refuses a cache archive replaced between its path check and the opened handle (invalid-storage)', { timeout: 30_000 }, async () => {
    const value = await fixture(), file = join(value.root, 'cached-archive'), staging = join(value.root, 'staging-archive')
    const byteLength = 4096
    await writeFile(file, Buffer.alloc(byteLength, 1))
    const stopped = { value: false }
    const replacing = (async () => {
      let variant = 0
      while (!stopped.value) {
        variant += 1
        await writeFile(staging, Buffer.alloc(byteLength, variant % 251))
        try { await rename(staging, file) } catch (error) {
          // A native open handle may refuse the swap in this exact window; retry it.
          if (!['EPERM', 'EACCES', 'EBUSY', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        }
      }
    })()
    try {
      const refusal = await refusedCode(async () => await readMarketBytes(file, byteLength), 'invalid-storage', 600)
      expect(refusal).toMatchObject({ code: 'invalid-storage' })
    } finally {
      stopped.value = true
      await replacing
    }
  })

  it('refuses a bounded read whose archive grows past the bound after the size check (invalid-storage)', { timeout: 30_000 }, async () => {
    const value = await fixture(), file = join(value.root, 'growing-archive'), bound = 16 * 1024 * 1024
    const complete = Buffer.alloc(bound, 3)
    let refusal: MarketError | undefined
    for (let attempt = 0; attempt < 4 && refusal === undefined; attempt += 1) {
      await writeFile(file, complete)
      const reading = readMarketBytes(file, bound)
      let settled = false
      const guarded = reading.then(() => { settled = true }, () => { settled = true })
      await settle(value.scratch, 4)
      const inFlight = !settled
      await appendFile(file, Buffer.from('x'))
      await guarded
      try { await reading } catch (error) {
        if (!(error instanceof MarketError)) throw error
        if (inFlight && error.code === 'invalid-storage') refusal = error
      }
    }
    expect(refusal).toMatchObject({ code: 'invalid-storage' })
  })

  it('refuses a bounded read whose archive is rewritten while the read is in flight (changed-resource)', { timeout: 30_000 }, async () => {
    const value = await fixture(), file = join(value.root, 'rewritten-archive'), byteLength = 2 * 1024 * 1024
    const original = Buffer.alloc(byteLength, 5), variant = Buffer.alloc(byteLength, 6)
    await writeFile(file, original)
    const stopped = { value: false }
    const rewriting = (async () => {
      while (!stopped.value) {
        await writeFile(file, variant)
        if (!stopped.value) await writeFile(file, original)
      }
    })()
    try {
      const refusal = await refusedCode(async () => await readMarketBytes(file, byteLength), 'changed-resource', 40)
      expect(refusal).toMatchObject({ code: 'changed-resource' })
    } finally {
      stopped.value = true
      await rewriting
    }
  })

  it('refuses a verified installation whose extracted resource is rewritten between the walk and the exact re-read', { timeout: 30_000 }, async () => {
    const value = await fixture()
    const race = { ...limits, archiveBytes: 32 * 1024 * 1024, expandedBytes: 32 * 1024 * 1024 }
    const target = 'skills/fixture-skill/a-first.txt'
    const original = Buffer.from('original target bytes'), mutated = Buffer.from('mutated target bytes!')
    // The trailing large resource keeps the walk busy after the target was accepted, so a
    // single rewrite of an already-walked resource stays inside the same verification.
    const extra = { 'skills/fixture-skill/z-last/padding.bin': Buffer.alloc(4 * 1024 * 1024) }
    const archive = createMarketPackage(manifest, { ...resources, [target]: original, ...extra }, race)
    const local = new MuseMarketLocal({ root: join(value.root, 'market'), limits: race })
    await local.ready()
    const installed = await local.install(archive)
    const cached = join(value.root, 'market', 'packages', installed.release.id, ...target.split('/'))
    const refusals: string[] = []
    // Three independent placements of one rewrite; the window lasts for the whole walk of
    // the trailing resource, which is why no clock finer than either probe is required.
    for (const pause of ['ops:30', 'ops:120', 'timer'] as const) {
      await writeFile(cached, original)
      // Settle the verification's own refusal as soon as it happens: the rewrite below runs
      // while the reader is still inside the walk, so its rejection must not stay unobserved.
      const verifying = local.verify(installed.release).then(() => 'served', (error: unknown) => error)
      if (pause === 'timer') await new Promise((resolve) => { setTimeout(resolve, 0) })
      else await settle(value.scratch, Number(pause.slice('ops:'.length)))
      await writeFile(cached, mutated)
      const outcome = await verifying
      if (outcome === 'served') continue
      if (!(outcome instanceof MarketError)) throw outcome
      refusals.push(outcome.code)
    }
    expect(refusals).toContain('modified-installation')
    await writeFile(cached, original)
    expect(await local.verify(installed.release)).toEqual(Buffer.from(archive))
  })
})

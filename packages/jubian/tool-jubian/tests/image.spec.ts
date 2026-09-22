/**
 * The paid image route's pin, and the `jubianImage` namespace a Settings page
 * lists the pinnable rows over.
 *
 * The pin has two homes — the short-drama settings section a person edits, and
 * this row's own composition config — and the tests below fix which one wins and
 * what a malformed section does. The namespace read is driven against a stub
 * transport, because what it must prove is the request it makes, the rows it
 * offers, and the refusal it reports.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { JubianClient } from '@deepseek-ai/dsh-jubian'
import { JubianImageRoutes, pinnedImageSelection } from '../src/image.ts'

/** The live account catalogue's shape: two `gpt-image-2` rows beside another model. */
const CATALOGUE = [
  { id: 66, modelId: 'gpt-image-2', platformId: 'KU_AI', unitPrice: 0.12, unit: '元/条' },
  { id: 35, modelId: 'doubao-seedream-4-0-250828', platformId: 'FANG_ZHOU', unitPrice: 0.116, unit: '元/张' },
  { id: 76, modelId: 'gpt-image-2', platformId: 'DUO_YUAN_TAN_SUO', unitPrice: 1.05, unit: '元/条' },
]

/**
 * A host context whose settings service resolves one `drama` section.
 * @param section - the section to resolve, or undefined for a namespace with no document.
 * @returns the context, with the settings service provided when a section was given.
 */
function host(section?: unknown): Context {
  const ctx = new Context()
  ctx.provide('settings', { get: (ns: string) => (ns === 'drama' ? section : undefined) })
  return ctx
}

/** A host context without a settings service at all. */
function bare(): Context {
  return new Context()
}

describe('pinnedImageSelection', () => {
  it('pins nothing while neither the settings section nor the config names a row', () => {
    expect(pinnedImageSelection(bare(), {})).toEqual({})
    expect(pinnedImageSelection(host({}), {})).toEqual({})
  })

  it('reads the composition config when the settings page pins no row', () => {
    expect(pinnedImageSelection(bare(), { imageStandardId: 66 })).toEqual({ standardId: 66 })
    expect(pinnedImageSelection(bare(), { imagePlatformId: 'KU_AI' })).toEqual({ platformId: 'KU_AI' })
  })

  it('lets the settings page decide the whole selection once it pins a row', () => {
    expect(pinnedImageSelection(host({ imageStandardId: 76 }), { imageStandardId: 66 }))
      .toEqual({ standardId: 76 })
    // A composition platform beside the page's row would fail a call the person
    // had already decided, so it is dropped rather than merged.
    expect(pinnedImageSelection(host({ imageStandardId: 76 }), { imagePlatformId: 'KU_AI' }))
      .toEqual({ standardId: 76 })
  })

  it('treats anything but a positive integer in that section as no pin', () => {
    for (const section of ['drama', 66, null, { imageStandardId: 0 }, { imageStandardId: -1 },
      { imageStandardId: 3.5 }, { imageStandardId: '66' }]) {
      expect(pinnedImageSelection(host(section), { imageStandardId: 66 })).toEqual({ standardId: 66 })
    }
  })
})

describe('the jubianImage Remote namespace', () => {
  /**
   * Mount the namespace over a stub transport.
   * @param request - the transport call this test drives.
   * @returns the Host service under its Remote namespace.
   */
  async function boot(request: (options: { path: string }) => Promise<unknown>): Promise<JubianImageRoutes> {
    const ctx = new Context()
    await ctx.plugin(JubianImageRoutes, { client: { request } as unknown as JubianClient })
    return ctx.jubianImage
  }

  it('lists the gpt-image-2 rows with their own platforms and prices, and nothing else', async () => {
    const paths: string[] = []
    const routes = await boot(async (options) => {
      paths.push(options.path)
      return { data: CATALOGUE }
    })
    await expect(routes.routes()).resolves.toEqual({ candidates: [
      { standardId: 66, platformId: 'KU_AI', unitPrice: 0.12, unit: '元/条' },
      { standardId: 76, platformId: 'DUO_YUAN_TAN_SUO', unitPrice: 1.05, unit: '元/条' },
    ] })
    // The account's own image catalogue, read once, exactly as the paid call reads it.
    expect(paths).toEqual(['/model/charge/getSelectList?taskType=2'])
  })

  it('reports an unreadable catalogue with the transport\'s own reason', async () => {
    const routes = await boot(async () => { throw new Error('Jubian credential is not configured') })
    await expect(routes.routes()).rejects.toMatchObject({
      code: 'jubian-image/catalogue-unreadable',
      details: {},
    })
    await expect(routes.routes()).rejects.toThrow('Jubian credential is not configured')
  })
})

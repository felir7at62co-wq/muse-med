/** Every standalone runtime file declared for packing needs a real bundle entry. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { z } from 'zod'
import runtimeBundles from '../tsdown.config.ts'

it('bundles every explicitly published Desktop Host runtime entry', () => {
  const manifest = z.object({ files: z.array(z.string()) }).parse(
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
  )
  const declared = manifest.files.filter(path => /^lib\/[^/]+\.js$/u.test(path)).sort()
  const bundles = z.array(z.object({
    entry: z.tuple([z.string()]), outDir: z.literal('lib'), format: z.tuple([z.literal('esm')]),
    outputOptions: z.object({ codeSplitting: z.literal(false) }), clean: z.literal(false),
  })).parse(runtimeBundles)
  const emitted = bundles.map(bundle => bundle.entry[0].replace(/^lib\/types\//u, 'lib/')).sort()
  expect(new Set(emitted).size).toBe(emitted.length)
  expect(emitted).toEqual(declared)
})

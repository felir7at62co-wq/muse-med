import { readFile } from 'node:fs/promises'
import { zipSync, unzipSync } from 'fflate'
import { expect, it } from 'vitest'
import { bindMarketPortrait, marketManifest, previewMarketPackage } from '../src/format.ts'
import { marketPresetPortraitIds } from '../src/types.ts'
import { readMarketPackage } from '../src/package.ts'

const limits = { archiveBytes: 1048576, expandedBytes: 4194304, fileCount: 64 }
const allowed = ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-skill']
const sample = async () => readFile(new URL('./fixtures/handoff/storyboard-starter-1.0.0.zip', import.meta.url))

it.each([['storyboard-director', 'bot'], ['storyboard-starter', 'skill']])('previews the exact %s handoff archive', async (name, kind) => {
  const bytes = await readFile(new URL('./fixtures/handoff/' + name + '-1.0.0.zip', import.meta.url))
  expect(previewMarketPackage(bytes, limits, allowed)).toEqual(readMarketPackage(bytes, limits, allowed).manifest)
  expect(previewMarketPackage(bytes, limits, allowed).kind).toBe(kind)
})

it('binds every selectable portrait while retaining compatible legacy metadata and resource bytes', async () => {
  const bytes = await readFile(new URL('./fixtures/handoff/storyboard-director-1.0.0.zip', import.meta.url))
  const legacy = bindMarketPortrait(bytes, 'storyboard-director', limits, allowed)
  const { files, manifest: legacyManifest } = readMarketPackage(legacy, limits, allowed)
  expect(new Set(marketPresetPortraitIds).size).toBe(50)
  for (const portrait of marketPresetPortraitIds) {
    const archive = bindMarketPortrait(legacy, portrait, limits, allowed)
    const expected = portrait === 'screenplay-editor'
      ? { ...legacyManifest, portrait }
      : { ...legacyManifest, presetPortrait: portrait }
    expect(previewMarketPackage(archive, limits, allowed)).toEqual(expected)
    const publication = readMarketPackage(archive, limits, allowed)
    expect(publication.manifest).toEqual(expected)
    expect(publication.files).toEqual(files)
  }
  const updated = bindMarketPortrait(legacy, 'video-editor', limits, allowed)
  expect(previewMarketPackage(bindMarketPortrait(updated, 'screenplay-editor', limits, allowed), limits, allowed))
    .toEqual({ ...legacyManifest, portrait: 'screenplay-editor' })
  expect(() => marketManifest({ ...legacyManifest, portrait: 'video-editor' }, allowed)).toThrow('invalid-manifest')
  expect(() => marketManifest({ ...legacyManifest, presetPortrait: 'unknown-portrait' }, allowed)).toThrow('invalid-manifest')
  const skillArchive = await sample()
  expect(() => bindMarketPortrait(skillArchive, 'video-editor', limits, allowed)).toThrow('invalid-manifest')
})

it('keeps metadata preview separate from server resource acceptance', async () => {
  const entries = unzipSync(await sample())
  const path = Object.keys(entries).find(name => name.endsWith('/SKILL.md'))!
  entries[path] = new TextEncoder().encode('Modified resource body')
  const modified = zipSync(entries)
  expect(previewMarketPackage(modified, limits, allowed).name).toBe('storyboard-starter')
  expect(() => readMarketPackage(modified, limits, allowed)).toThrow('file-mismatch')
})

it('bounds all ZIP entries while inflating only the preview manifest', async () => {
  const bytes = await sample()
  expect(() => previewMarketPackage(bytes, { ...limits, archiveBytes: bytes.length - 1 }, allowed)).toThrow('archive-too-large')
  expect(previewMarketPackage(bytes, { ...limits, archiveBytes: bytes.length }, allowed).kind).toBe('skill')
  expect(() => previewMarketPackage(bytes, { ...limits, fileCount: 1 }, allowed)).toThrow('expanded-limit')
  expect(() => previewMarketPackage(bytes, { ...limits, expandedBytes: 1 }, allowed)).toThrow('expanded-limit')
  expect(() => previewMarketPackage(new Uint8Array(), limits, allowed)).toThrow('archive-too-large')
  expect(() => previewMarketPackage(new Uint8Array([1, 2, 3]), limits, allowed)).toThrow('invalid-archive')
})

it('refuses unsafe preview paths, missing metadata and malformed UTF-8 or JSON', async () => {
  const entries = unzipSync(await sample())
  expect(() => previewMarketPackage(zipSync({ ...entries, '../escape': new Uint8Array([1]) }), limits, allowed)).toThrow('invalid-path')
  expect(() => previewMarketPackage(zipSync({ ...entries, 'MUSE-PACKAGE.JSON': new Uint8Array([1]) }), limits, allowed)).toThrow('invalid-path')
  expect(() => previewMarketPackage(zipSync({ 'resource.txt': new Uint8Array([1]) }), limits, allowed)).toThrow('invalid-manifest')
  for (const data of [new Uint8Array([255]), new TextEncoder().encode('{'), new Uint8Array(128 * 1024 + 1)]) {
    expect(() => previewMarketPackage(zipSync({ 'muse-package.json': data }), limits, allowed)).toThrow('invalid-manifest')
  }
})

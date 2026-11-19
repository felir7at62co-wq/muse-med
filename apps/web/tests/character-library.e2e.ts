/** Read-only character browsing through the shipped Web composition and real Remote transport. */
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-character-library'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z1D/HwAF/gJ+fM5MPgAAAABJRU5ErkJggg==', 'base64')
const sha256 = createHash('sha256').update(png).digest('hex')
const mode = webSnapshotMode()
const expected = (name: string): string => fileURLToPath(new URL(`./expected/character-library/${name}.expected.md`, import.meta.url))

it('opens the library from the left navigation and reports an unconfigured store', async () => {
  const scaffold = await launchWebScaffold()
  const status = vi.spyOn(scaffold.ctx.characterLibraryObjectStore, 'status')
    .mockReturnValue({ readConfigured: false, writeConfigured: false })
  try {
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Asset library', exact: true }).click()
      await page.getByText('The character library is not connected. Ask your administrator to enable access.', { exact: true }).waitFor()
      await compareOrRefreshGolden(expected('offline'), await captureStableAria(page, 'section:has(h1)', scaffold.workspaceCwd), mode)
    } finally { await browser.close() }
  } finally { status.mockRestore(); await scaffold.close() }
})

it('synchronizes cloud additions and removals while browsing without exposing a modification action', async () => {
  const objects = new Map<string, { data: Buffer; contentType: string }>()
  const addCharacter = (collection: 'ancient' | 'urban', id: string, tag: string): void => {
    const prefix = `assets/reference/characters/stylized/${collection}/${collection}/${id}/`
    objects.set(`${prefix}metadata.json`, { contentType: 'application/json', data: Buffer.from(JSON.stringify({
      schema_version: 2, id, status: 'pending_review', category: 'character',
      style: '3D', era: [collection], tags: [tag],
      images: [{ filename: 'portrait.png', sha256, bytes: png.byteLength }],
      source: { platform: 'synthetic-test', rights_status: 'unconfirmed' },
    })) })
    objects.set(`${prefix}portrait.png`, { data: png, contentType: 'image/png' })
  }
  addCharacter('ancient', 'char_3d_0004', 'blue robe')
  addCharacter('urban', 'char_3d_0002', 'black suit')
  const originalFetch = globalThis.fetch
  // The shipped public provider remains mounted; only TOS HTTP responses are replaced.
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.origin !== 'https://muse.tos-cn-beijing.volces.com') return originalFetch(input, init)
    if (url.pathname === '/') {
      expect(init?.method).toBe('GET')
      expect(url.searchParams.get('list-type')).toBe('2')
      const prefix = url.searchParams.get('prefix')
      expect(['assets/reference/characters/stylized/ancient/ancient/', 'assets/reference/characters/stylized/urban/urban/']).toContain(prefix)
      const maxKeys = Number(url.searchParams.get('max-keys'))
      expect(maxKeys).toBeGreaterThan(0)
      expect(maxKeys).toBeLessThanOrEqual(128)
      const contents = [...objects].filter(([key]) => prefix !== null && key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([Key, value]) => ({ Key, Size: value.data.byteLength, ETag: createHash('md5').update(value.data).digest('hex') }))
      expect(contents.length).toBeLessThanOrEqual(maxKeys)
      const body = JSON.stringify({ Name: 'muse', Prefix: prefix, MaxKeys: maxKeys,
        KeyCount: contents.length, IsTruncated: false, Contents: contents })
      return new Response(body, { status: 200, headers: {
        'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)),
      } })
    }
    expect(url.search).toBe('')
    const key = decodeURIComponent(url.pathname.slice(1))
    const value = objects.get(key)
    if (value === undefined) return new Response(null, { status: 404 })
    const headers = { 'content-type': value.contentType, 'content-length': String(value.data.byteLength) }
    if (init?.method === 'HEAD') return new Response(null, { status: 200, headers })
    expect(init?.method).toBe('GET')
    expect(new Headers(init?.headers).get('range')).toMatch(/^bytes=0-[0-9]+$/u)
    return new Response(new Uint8Array(value.data), { status: 206, headers: {
      ...headers, 'content-range': `bytes 0-${value.data.byteLength - 1}/${value.data.byteLength}`,
    } })
  })
  try {
    const scaffold = await launchWebScaffold({ extraOverlayPath: fileURLToPath(new URL('./fixtures/character-library-sync.overlay.yml', import.meta.url)) })
    try {
      const browser = await chromium.launch()
      try {
        const page = await newEnglishPage(browser)
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await page.getByRole('button', { name: 'Asset library', exact: true }).click()
        const ancient = page.getByRole('button', { name: 'View character reference: char_3d_0004', exact: true })
        const urban = page.getByRole('button', { name: 'View character reference: char_3d_0002', exact: true })
        await ancient.waitFor()
        await urban.waitFor()
        await expect.poll(() => ancient.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0) && images.length === 1)).toBe(true)
        const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Shared assets', exact: true }) })
        await compareOrRefreshGolden(expected('catalog'), await captureStableAria(page, 'section:has(h1)', scaffold.workspaceCwd), mode)
        expect(await section.getByRole('button', { name: /upload|delete|edit|save|apply/i }).count()).toBe(0)
        for (const scheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: scheme })
          await ancient.click()
          const dialog = page.getByRole('dialog')
          await dialog.waitFor()
          await expect.poll(() => dialog.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1)
          await page.keyboard.press('Escape')
          await expect.poll(() => dialog.count()).toBe(0)
        }
        addCharacter('urban', 'char_urban_future_001', 'new cloud reference')
        const added = page.getByRole('button', { name: 'View character reference: char_urban_future_001', exact: true })
        await added.waitFor()
        await expect.poll(() => added.locator('img').evaluateAll(images => images.length === 1 && (images[0] as HTMLImageElement).naturalWidth === 1)).toBe(true)
        await compareOrRefreshGolden(expected('synchronized'), await captureStableAria(page, 'section:has(h1)', scaffold.workspaceCwd), mode)
        for (const key of objects.keys()) {
          if (key.startsWith('assets/reference/characters/stylized/ancient/ancient/char_3d_0004/')) objects.delete(key)
        }
        await expect.poll(() => ancient.count()).toBe(0)
        expect(await section.getByRole('button', { name: /upload|delete|edit|save|apply/i }).count()).toBe(0)
        await page.getByRole('tab', { name: 'Urban', exact: true }).click()
        await expect.poll(() => ancient.count()).toBe(0)
        await urban.waitFor()
        await page.getByRole('textbox', { name: 'Search appearance, style or tags', exact: true }).fill('blue robe')
        await page.getByRole('button', { name: 'Search', exact: true }).click()
        await page.getByText('No matching character references', { exact: true }).waitFor()
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  } finally { transport.mockRestore() }
})

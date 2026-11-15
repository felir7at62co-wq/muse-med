/** Desktop carriers keep a complete interpreter payload even when SDK carriers choose Python-only. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { expect, it } from 'vitest'
import { prepareMacFonts, smokePrimaryRuntime } from '../scripts/prepare-primary-runtime.ts'
import { validateMediaLock } from '../scripts/prepare-media-runtime.ts'

it('rejects a Python-only native Desktop payload before executing interpreters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-python-only-'))
  try {
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
      desktopVersion: '1.0.0', platform: process.platform, arch: process.arch,
      python: '3.12.14', pythonPackages: { numpy: '2.3.5', pandas: '3.0.1' },
    }))
    expect(() => { smokePrimaryRuntime(root) }).toThrow('Desktop payload must declare node and pnpm')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('packages both locked Mac fonts and licenses offline and rejects a changed cached resource', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-mac-fonts-'))
  try {
    const cache = join(root, 'cache'), output = join(root, 'media')
    await mkdir(cache)
    const subtitle = Buffer.from('subtitle fixture')
    const resources = new Map<string, Buffer>([
      ['watermark.otf', Buffer.from('watermark fixture')],
      ['subtitle.zip', Buffer.from(zipSync({ 'subtitle.ttf': subtitle }))],
      ['LICENSE-NotoSansCJK.txt', Buffer.from('noto license')],
      ['LICENSE-ZhuqueFangsong.txt', Buffer.from('zhuque license')],
    ])
    const entry = (filename: string) => {
      const bytes = resources.get(filename)!
      return { filename, url: `https://example.com/${filename}`, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') }
    }
    const raw: unknown = JSON.parse(await readFile(new URL('../scripts/media-runtime.lock.json', import.meta.url), 'utf8'))
    const base = validateMediaLock(raw)
    const lock = validateMediaLock({ ...base, font: entry('watermark.otf'), subtitleFontArchive: entry('subtitle.zip'),
      subtitleFont: { filename: 'subtitle.ttf', bytes: subtitle.length, sha256: createHash('sha256').update(subtitle).digest('hex') },
      notices: [entry('LICENSE-NotoSansCJK.txt'), entry('LICENSE-ZhuqueFangsong.txt')] })
    for (const [filename, bytes] of resources) await writeFile(join(cache, filename), bytes)
    await prepareMacFonts(output, cache, lock)
    expect(await readFile(join(output, 'fonts', 'subtitle.ttf'))).toEqual(subtitle)
    expect(await readFile(join(output, 'fonts', 'watermark.otf'))).toEqual(resources.get('watermark.otf'))
    for (const notice of lock.notices) expect(await readFile(join(output, 'notices', notice.filename))).toEqual(resources.get(notice.filename))
    await writeFile(join(cache, 'subtitle.zip'), 'tampered')
    await expect(prepareMacFonts(output, cache, lock)).rejects.toThrow(/size|checksum/)
    await expect(prepareMacFonts(output, cache, { ...lock, notices: [] })).rejects.toThrow('missing font license')
  } finally { await rm(root, { recursive: true, force: true }) }
})

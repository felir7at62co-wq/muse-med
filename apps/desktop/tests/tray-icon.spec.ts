import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { APP_ICON_PATHS, WINDOW_ICON_PATHS, packIco, renderAppIcon, renderWindowIcon, TRAY_ICON_PATHS, TRAY_ICON_SIZES, unpackIco, type IcoEntry } from '../scripts/render-tray-icon.ts'

/** Smallest valid-looking PNG stream: signature plus an IHDR chunk declaring the given edge. */
function pngStub(width: number, height = width): Buffer {
  const png = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12)
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(height, 20)
  return png
}

describe('tray icon packaging', () => {
  it('packs PNG entries into a Vista-style ICO directory and reads them back', () => {
    const entries: IcoEntry[] = [{ size: 16, png: pngStub(16) }, { size: 256, png: pngStub(256) }]
    const ico = packIco(entries)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(2)
    // 256 px is encoded as 0 in the one-byte edge fields.
    expect([ico.readUInt8(6 + 16), ico.readUInt8(6 + 17)]).toEqual([0, 0])
    expect(ico.readUInt32LE(6 + 12)).toBe(6 + 32)
    expect(unpackIco(ico)).toEqual(entries)
  })

  it('rejects bitmaps that disagree with their declared edge, oversized edges, and non-PNG data', () => {
    expect(() => packIco([{ size: 16, png: pngStub(24) }])).toThrow('is 24x24, expected 16')
    expect(() => packIco([{ size: 512, png: pngStub(512) }])).toThrow('unsupported bitmap edge 512')
    expect(() => packIco([{ size: 16, png: Buffer.from('not a png stream, long enough to be read') }])).toThrow('not a PNG stream')
    expect(() => unpackIco(Buffer.from('BM'))).toThrow('not an ICO file')
    const forged = packIco([{ size: 16, png: pngStub(16) }])
    forged.writeUInt8(20, 6)
    expect(() => unpackIco(forged)).toThrow('declares 20 but holds 16x16')
  })

  it('ships one crisp bitmap per supported display scale in the committed tray icon', () => {
    const entries = unpackIco(readFileSync(TRAY_ICON_PATHS.output))
    expect(entries.map(entry => entry.size)).toEqual([...TRAY_ICON_SIZES])
    for (const entry of entries) expect(entry.png.length).toBeGreaterThan(100)
  })

  it('keeps the large app icon corners transparent around its rounded black tile', async () => {
    const { data, info } = await sharp(readFileSync(new URL('../renderer/icon.png', import.meta.url))).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const pixel = (x: number, y: number): number[] => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)]
    expect(pixel(0, 0)[3]).toBe(0)
    expect(pixel(info.width - 1, info.height - 1)[3]).toBe(0)
    const original = await sharp(readFileSync(APP_ICON_PATHS.source)).ensureAlpha().raw().toBuffer()
    const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4
    expect(pixel(Math.floor(info.width / 2), Math.floor(info.height / 2))).toEqual([...original.subarray(center, center + 4)])
    expect(original[center]).toBeGreaterThan(240)
    expect(pixel(Math.floor(info.width / 2), Math.floor(info.height / 8))[3]).toBe(255)
  })

  it('ships transparent black spiders at every tray size without a filled background', async () => {
    const images = [readFileSync(WINDOW_ICON_PATHS.output), ...unpackIco(readFileSync(TRAY_ICON_PATHS.output)).map(entry => entry.png)]
    for (const image of images) {
      const { data } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const alpha: number[] = []
      for (let offset = 0; offset < data.length; offset += 4) {
        expect([...data.subarray(offset, offset + 3)]).toEqual([0, 0, 0])
        alpha.push(data[offset + 3]!)
      }
      expect(alpha[0]).toBe(0)
      expect(Math.max(...alpha)).toBe(255)
    }
  })

  it('reproduces committed rounded application and transparent window assets from their originals', async () => {
    expect(await renderAppIcon(readFileSync(APP_ICON_PATHS.source))).toEqual(readFileSync(APP_ICON_PATHS.output))
    expect(await renderWindowIcon(readFileSync(WINDOW_ICON_PATHS.source))).toEqual(readFileSync(WINDOW_ICON_PATHS.output))
  })

  it('uses transparent window artwork for the Windows tray and rounded artwork for the installed app', async () => {
    const muse = readFileSync(new URL('../renderer/icon.png', import.meta.url))
    const tray = unpackIco(readFileSync(TRAY_ICON_PATHS.output))
    const tray64 = tray.find(entry => entry.size === 64)
    const trayMuse64 = await sharp(readFileSync(WINDOW_ICON_PATHS.output)).resize(64, 64).png().toBuffer()
    expect(tray64?.png.equals(trayMuse64)).toBe(true)

    const installed = unpackIco(readFileSync(new URL('../renderer/icon.ico', import.meta.url)))
    const installed256 = installed.find(entry => entry.size === 256)
    const installerMuse256 = await sharp(muse).resize(256, 256).png().toBuffer()
    expect(installed256?.png.equals(installerMuse256)).toBe(true)
  })
})

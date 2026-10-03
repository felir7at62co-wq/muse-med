/** Render rounded Muse application artwork and transparent Windows window/tray artwork. */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Bitmap edge lengths bundled in the tray icon: 16 px at 100 % through 400 % display scale. */
export const TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64] as const
/** Bitmap edges bundled in the Windows installer icon. */
export const INSTALLER_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256] as const

/** Original application artwork and its rounded export used by app and installer packaging. */
export const APP_ICON_PATHS = {
  source: fileURLToPath(new URL('../resources/muse-app-source.png', import.meta.url)),
  output: fileURLToPath(new URL('../renderer/icon.png', import.meta.url)),
} as const
/** High-resolution transparent spider and the Windows window/taskbar export. */
export const WINDOW_ICON_PATHS = {
  source: fileURLToPath(new URL('../../web/public/muse-med-logo-white.webp', import.meta.url)),
  output: fileURLToPath(new URL('../renderer/window-icon.png', import.meta.url)),
} as const
/** Transparent Windows tray bitmaps consumed by development and packaged builds. */
export const TRAY_ICON_PATHS = {
  source: WINDOW_ICON_PATHS.output,
  output: fileURLToPath(new URL('../resources/tray-windows.ico', import.meta.url)),
} as const
/** Muse artwork and committed Windows executable icon. */
export const INSTALLER_ICON_PATHS = {
  source: APP_ICON_PATHS.output,
  output: fileURLToPath(new URL('../renderer/icon.ico', import.meta.url)),
} as const

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ICON_DIRECTORY_BYTES = 6
const ICON_ENTRY_BYTES = 16

/** One bitmap of an icon file. */
export interface IcoEntry {
  readonly size: number
  /** Complete PNG stream; Windows Vista and later read PNG-compressed entries directly. */
  readonly png: Buffer
}

/**
 * Pack PNG bitmaps into one ICO file.
 * @param entries - Bitmaps in ascending size; each PNG must be square with the declared edge.
 * @returns the ICO bytes.
 */
export function packIco(entries: readonly IcoEntry[]): Buffer {
  const header = Buffer.alloc(ICON_DIRECTORY_BYTES + ICON_ENTRY_BYTES * entries.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach((entry, index) => {
    if (entry.size < 1 || entry.size > 256) throw new Error(`tray icon: unsupported bitmap edge ${String(entry.size)}`)
    const { width, height } = pngDimensions(entry.png)
    if (width !== entry.size || height !== entry.size) {
      throw new Error(`tray icon: bitmap ${String(index)} is ${String(width)}x${String(height)}, expected ${String(entry.size)}`)
    }
    const at = ICON_DIRECTORY_BYTES + ICON_ENTRY_BYTES * index
    // 256 px is encoded as 0 in the one-byte edge fields.
    header.writeUInt8(entry.size % 256, at)
    header.writeUInt8(entry.size % 256, at + 1)
    header.writeUInt8(0, at + 2)
    header.writeUInt8(0, at + 3)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(entry.png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })
  return Buffer.concat([header, ...entries.map(entry => entry.png)])
}

/**
 * Read the bitmaps back out of one ICO file.
 * @param ico - Bytes written by {@link packIco} or another PNG-entry ICO producer.
 * @returns entries in directory order, each PNG checked against its declared edge.
 */
export function unpackIco(ico: Buffer): IcoEntry[] {
  if (ico.length < ICON_DIRECTORY_BYTES || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new Error('tray icon: not an ICO file')
  }
  const count = ico.readUInt16LE(4)
  return Array.from({ length: count }, (_, index) => {
    const at = ICON_DIRECTORY_BYTES + ICON_ENTRY_BYTES * index
    const declared = ico.readUInt8(at)
    const size = declared === 0 ? 256 : declared
    const length = ico.readUInt32LE(at + 8)
    const offset = ico.readUInt32LE(at + 12)
    const png = ico.subarray(offset, offset + length)
    const { width, height } = pngDimensions(png)
    if (width !== size || height !== size) throw new Error(`tray icon: entry ${String(index)} declares ${String(size)} but holds ${String(width)}x${String(height)}`)
    return { size, png }
  })
}

/**
 * Resize generated artwork separately for each Windows bitmap size.
 * @param source - Square application or transparent spider artwork.
 * @param sizes - Bitmap edges to render.
 * @returns PNG entries in the given order.
 */
export async function renderTrayIconEntries(source: Buffer, sizes: readonly number[] = TRAY_ICON_SIZES): Promise<IcoEntry[]> {
  return Promise.all(sizes.map(async size => ({
    size,
    png: await sharp(source).resize(size, size).png().toBuffer(),
  })))
}

/**
 * Round the original application's black tile without altering its spider artwork.
 * @param source - Original square Muse image.
 * @returns 1024-pixel application PNG with transparent rounded corners.
 */
export async function renderAppIcon(source: Buffer): Promise<Buffer> {
  const mask = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" rx="224" fill="white"/></svg>')
  return sharp(source).resize(1024, 1024).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer()
}

/**
 * Preserve the transparent spider's alpha while rendering its fill in pure black.
 * @param source - High-resolution transparent Muse spider.
 * @returns 256-pixel PNG with a centered black spider and transparent padding.
 */
export async function renderWindowIcon(source: Buffer): Promise<Buffer> {
  const { data: alpha, info } = await sharp(source).trim().resize(224, 224, { fit: 'inside' })
    .ensureAlpha().extractChannel('alpha').raw().toBuffer({ resolveWithObject: true })
  const mark = await sharp({ create: { width: info.width, height: info.height, channels: 3, background: '#000000' } })
    .joinChannel(alpha, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer()
  return sharp({ create: { width: 256, height: 256, channels: 4, background: '#00000000' } })
    .composite([{ input: mark, gravity: 'centre' }]).png().toBuffer()
}

function pngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('tray icon: bitmap is not a PNG stream')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

async function main(): Promise<void> {
  const artwork = await renderAppIcon(await readFile(APP_ICON_PATHS.source))
  const window = await renderWindowIcon(await readFile(WINDOW_ICON_PATHS.source))
  const tray = await renderTrayIconEntries(window)
  const installer = await renderTrayIconEntries(artwork, INSTALLER_ICON_SIZES)
  await writeFile(APP_ICON_PATHS.output, artwork)
  await writeFile(WINDOW_ICON_PATHS.output, window)
  await writeFile(TRAY_ICON_PATHS.output, packIco(tray))
  await writeFile(INSTALLER_ICON_PATHS.output, packIco(installer))
  console.info('desktop icons: wrote application, window, tray, and installer artwork')
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()

/**
 * Writing a directory tree's planned members as a `.tar.zst` archive.
 *
 * Compression is Node's own zstd and the tar framing is written here, because
 * the repository's `tar` package is a transitive dependency of `apps/desktop`
 * and is not resolvable from `scripts/`.
 *
 * Records use the ustar layout. A member name longer than the 100-byte name
 * field is split across the 155-byte prefix field; one longer than both is
 * rejected rather than truncated, so an archive never silently misnames a file.
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants, createZstdCompress } from 'node:zlib'

/** One block of the ustar layout. */
export const BLOCK = 512

/** Default zstd level: high, because the Python pack is 2.7 GB of input. */
const ZSTD_LEVEL = 19

/** Size of one read when copying a file into an archive. */
const COPY_CHUNK = 1 << 20

/** One file an archive will hold: where it is read from and where it lands. */
export interface TarFile {
  /** Archive-relative path, POSIX separators, no trailing slash. */
  readonly name: string
  /** Absolute path of the real file whose bytes the archive stores. */
  readonly source: string
  /** Size in bytes the header declares; reading must produce exactly this. */
  readonly size: number
  /** Permission bits the header declares. */
  readonly mode: number
}

/** A directory the archive names explicitly, so empty ones survive extraction. */
export interface TarDir {
  /** Archive-relative path, POSIX separators, no trailing slash. */
  readonly name: string
  /** Permission bits the header declares. */
  readonly mode: number
}

/** What one archive write produced. */
export interface WrittenArchive {
  /** Bytes written to disk. */
  readonly bytes: number
  /** Lowercase hex sha256 of the written bytes. */
  readonly sha256: string
}

/**
 * Write one 512-byte header field in the octal form tar expects.
 * @param buffer - Header being filled.
 * @param value - Numeric field value.
 * @param offset - Field offset within the block.
 * @param length - Field width, including its terminator.
 */
function numeric(buffer: Buffer, value: number, offset: number, length: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, 'ascii')
}

/**
 * Build the header block for one member.
 * @param name - Archive-relative member path; directories keep a trailing slash.
 * @param size - Payload size in bytes; 0 for directories.
 * @param mode - Permission bits to declare.
 * @param type - Tar type flag: `0` for a file, `5` for a directory.
 * @returns The checksummed 512-byte header.
 */
export function tarHeader(name: string, size: number, mode: number, type: '0' | '5'): Buffer {
  const block = Buffer.alloc(BLOCK)
  let nameField = name
  let prefix = ''
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155)
    if (cut === -1) throw new Error(`tar member name cannot fit a ustar header: ${name}`)
    prefix = name.slice(0, cut)
    nameField = name.slice(cut + 1)
    if (Buffer.byteLength(nameField) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new Error(`tar member path exceeds the ustar fields: ${name}`)
    }
  }
  block.write(nameField, 0, 'utf8')
  numeric(block, mode, 100, 8)
  numeric(block, 0, 108, 8)
  numeric(block, 0, 116, 8)
  numeric(block, size, 124, 12)
  // A fixed epoch makes identical inputs byte-identical, so a rebuilt archive
  // matches even though the manifest's builtAt does not.
  numeric(block, 0, 136, 12)
  block.write('        ', 148, 'ascii')
  block.write(type, 156, 'ascii')
  block.write('ustar\0', 257, 'ascii')
  block.write('00', 263, 'ascii')
  block.write(prefix, 345, 'utf8')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return block
}

/**
 * Copy one file's bytes into an archive, refusing to let the archive disagree
 * with the size its header already declared.
 * @param sink - Open archive positioned at this member's body.
 * @param file - Member to copy.
 */
async function copyInto(sink: FileHandle, file: TarFile): Promise<void> {
  let written = 0
  for await (const chunk of createReadStream(file.source, { highWaterMark: COPY_CHUNK })) {
    const buffer = chunk as Buffer
    await sink.write(buffer)
    written += buffer.length
  }
  if (written !== file.size) {
    throw new Error(`${file.source} changed size while packing: header declares ${file.size}, read ${written}`)
  }
}

/**
 * Build the opening records: the extraction root, then one record per directory.
 *
 * These carry no payload, so they can all precede the file members.
 * @param root - Install-root-relative directory the archive extracts into.
 * @param dirs - Directories to name.
 * @returns The concatenated directory records.
 */
export function tarDirectoryRecords(root: string, dirs: readonly TarDir[]): Buffer {
  const blocks = [tarHeader(`${root}/`, 0, 0o755, '5')]
  for (const dir of dirs) blocks.push(tarHeader(`${dir.name}/`, 0, dir.mode, '5'))
  return Buffer.concat(blocks)
}

/**
 * Write one archive as a zstd-compressed tar.
 *
 * The two stages are ordered, not overlapped: the tar is completed and closed
 * on disk first, and only then is it read back and compressed. Reading the tar
 * while it is still being written would race the writer and compress a partial
 * file. `pipeline` owns termination, so its promise resolves only after every
 * byte of the finished archive has reached disk, which is what makes the
 * reported size and hash describe the download.
 * @param outFile - Absolute path to write.
 * @param root - Install-root-relative directory the archive extracts into.
 * @param dirs - Directories to name in the archive.
 * @param files - Files to store, in archive order.
 * @returns The written archive's size and content hash.
 */
export async function writeTarZst(
  outFile: string,
  root: string,
  dirs: readonly TarDir[],
  files: readonly TarFile[],
): Promise<WrittenArchive> {
  await mkdir(dirname(outFile), { recursive: true })
  const plainFile = `${outFile}.tar.part`
  await rm(outFile, { force: true })
  await rm(plainFile, { force: true })

  const sink = await open(plainFile, 'w')
  try {
    // Tar interleaves: each member's header is followed immediately by that
    // member's body, padded to a block boundary. Collecting headers into one
    // preamble would put later headers inside an earlier member's extent, which
    // leaves the stream unwalkable.
    await sink.write(tarDirectoryRecords(root, dirs))
    for (const file of files) {
      await sink.write(tarHeader(file.name, file.size, file.mode, '0'))
      await copyInto(sink, file)
      const remainder = file.size % BLOCK
      if (remainder !== 0) await sink.write(Buffer.alloc(BLOCK - remainder))
    }
    // The end-of-archive marker closes the last member, so it is written last.
    await sink.write(Buffer.alloc(BLOCK * 2))
  } finally {
    await sink.close()
  }

  const hash = createHash('sha256')
  let bytes = 0
  // The digest sits after compression, so the recorded bytes are the download.
  const digest = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk)
      bytes += chunk.length
      done(null, chunk)
    },
  })
  try {
    await pipeline(
      createReadStream(plainFile),
      createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } }),
      digest,
      createWriteStream(outFile),
    )
  } finally {
    await rm(plainFile, { force: true })
  }
  return { bytes, sha256: hash.digest('hex') }
}

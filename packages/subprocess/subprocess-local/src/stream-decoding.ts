/**
 * Text decoding for one captured output stream. Bytes that are well-formed
 * UTF-8 decode exactly as they always have; anything else is re-decoded with
 * the Windows ANSI code page, which is the encoding a native Windows program
 * writes to a redirected standard stream (`GetACP` reports 936 on a Chinese
 * host, 1252 on a Western one). PowerShell's own parse errors are the
 * motivating case: the whole `-Command` text is parsed before any statement —
 * including the `ENCODING_PREAMBLE` that pins `[Console]::OutputEncoding` — can
 * run, so a parse error reaches the collector in the console code page.
 * Decoding it as UTF-8 produced U+FFFD replacement characters per line, and no
 * producer-side pin can reach that stream.
 *
 * A slice that well-formed UTF-8 explains once a character split at a window
 * edge is restored keeps its replacement character: the collector trims its
 * retained head at a byte offset, and an incremental read starts and ends at
 * pipe-chunk offsets, so a UTF-8 stream reaches this module with a partial
 * character at an edge. Re-reading such a slice as a code page would replace
 * every character in it. Off Windows, and on a host whose code page has no
 * decoder in this runtime, the replacement decode also stands.
 *
 * @module @deepseek-ai/dsh-subprocess-local
 */

import { isUtf8 } from 'node:buffer'
import { extendWin32ProcessBindings } from '@deepseek-ai/dsh-win32-process'

/** One Windows ANSI code page and the decoder that reads it. */
export interface ConsoleCodePage {
  /** The code page, as `GetACP` reports it. */
  codePage: number
  /** Decoder for that code page. */
  decoder: TextDecoder
}

/**
 * Fallback decodes this process performed, for residual encoding statistics:
 * `total` counts slices decoded with a console code page instead of the UTF-8
 * replacement decode, and `codePage` is the code page of the most recent one
 * (0 before the first).
 */
export const consoleCodePageFallbacks = { total: 0, codePage: 0 }

/**
 * A UTF-8 character is at most four bytes, so a window cut mid-character
 * carries at most three bytes of it at an edge.
 */
const MAX_CUT_UTF8_BYTES = 3

let cachedConsoleCodePage: ConsoleCodePage | null | undefined

/**
 * The fallback decoder for this host, resolved once per process.
 * @returns the Windows ANSI code page decoder, or undefined when this host is
 * not Windows, its code page cannot be read, or this runtime has no decoder for
 * that code page.
 */
export function consoleCodePage(): ConsoleCodePage | undefined {
  if (cachedConsoleCodePage === undefined) {
    /* v8 ignore next 2 -- only a Windows host has an ANSI code page; POSIX lanes resolve undefined and keep the UTF-8 decode. */
    cachedConsoleCodePage = process.platform === 'win32' ? probeConsoleCodePage() : null
  }
  return cachedConsoleCodePage ?? undefined
}

/**
 * Decode one captured slice.
 * @param bytes - raw bytes of one incremental read or one final tail.
 * @param fallback - decoder for a slice that is not well-formed UTF-8, or null
 * to keep the replacement-character decode; defaults to this host's console
 * code page, resolved when a slice first needs it.
 * @returns the decoded text.
 */
export function decodeStreamText(
  bytes: Buffer,
  fallback: ConsoleCodePage | null = consoleCodePage() ?? null,
): string {
  if (isUtf8(bytes)) return bytes.toString('utf8')
  if (isCutUtf8Window(bytes)) return bytes.toString('utf8')
  if (fallback === null) return bytes.toString('utf8')
  consoleCodePageFallbacks.total += 1
  consoleCodePageFallbacks.codePage = fallback.codePage
  return fallback.decoder.decode(bytes)
}

/**
 * Whether well-formed UTF-8 with a character split at a window edge explains
 * these bytes, dropping only bytes an incomplete sequence can contribute. A
 * slice made entirely of partial characters explains itself: a read can hold
 * nothing but the middle of a character.
 * @param bytes - raw bytes of one slice.
 * @returns true when the slice is UTF-8 text cut at a window edge.
 */
function isCutUtf8Window(bytes: Buffer): boolean {
  const heads = cutHeadBytes(bytes)
  const tails = cutTailBytes(bytes)
  for (let head = 0; head <= heads; head += 1) {
    for (let tail = 0; tail <= tails; tail += 1) {
      if (head + tail === 0 || head + tail > bytes.length) continue
      if (isUtf8(bytes.subarray(head, bytes.length - tail))) return true
    }
  }
  return false
}

/**
 * How many leading bytes a window cut can explain: the continuation bytes of a
 * character whose lead byte fell outside the window.
 * @param bytes - raw bytes of one slice.
 * @returns 0 through {@link MAX_CUT_UTF8_BYTES}.
 */
function cutHeadBytes(bytes: Buffer): number {
  let count = 0
  while (count < MAX_CUT_UTF8_BYTES && count < bytes.length && isContinuation(bytes[count] as number)) {
    count += 1
  }
  return count
}

/**
 * How many trailing bytes a window cut can explain: the lead byte of a
 * character and fewer continuation bytes than it announces.
 * @param bytes - raw bytes of one slice.
 * @returns 0 through {@link MAX_CUT_UTF8_BYTES}.
 */
function cutTailBytes(bytes: Buffer): number {
  for (let count = 1; count <= MAX_CUT_UTF8_BYTES && count < bytes.length; count += 1) {
    const start = bytes.length - count
    if (announcedLength(bytes[start] as number) <= count) continue
    let continuations = true
    for (let index = start + 1; index < bytes.length; index += 1) {
      if (!isContinuation(bytes[index] as number)) {
        continuations = false
        break
      }
    }
    if (continuations) return count
  }
  return 0
}

/**
 * Whether one byte carries the continuation bits of a UTF-8 sequence.
 * @param byte - one raw byte.
 * @returns true for `0b10xxxxxx`.
 */
function isContinuation(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000
}

/**
 * The total length a UTF-8 lead byte announces, which a truncated tail falls
 * short of.
 * @param byte - one raw byte.
 * @returns 2, 3, or 4 for a valid lead byte, else 0.
 */
function announcedLength(byte: number): number {
  if (byte >= 0xf0 && byte <= 0xf4) return 4
  if (byte >= 0xe0) return 3
  if (byte >= 0xc2) return 2
  return 0
}

/**
 * The decoder for one Windows ANSI code page.
 * @param codePage - the value `GetACP` reported.
 * @returns the decoder, or undefined for a code page this runtime has no
 * decoder for — including 65001, where UTF-8 is already the console encoding
 * and a malformed slice has no better reading.
 */
export function decoderForCodePage(codePage: number): TextDecoder | undefined {
  const label = labelForCodePage(codePage)
  if (label === undefined) return undefined
  try {
    return new TextDecoder(label)
  } catch {
    /* v8 ignore next -- a runtime built without the legacy encodings rejects every label here; full-ICU lanes never take this arm. */
    return undefined
  }
}

/**
 * The decoder label for one Windows ANSI code page. The multi-byte code pages
 * keep their own WHATWG names; 1250 through 1258 are the single-byte Windows
 * code pages, whose label is the code page number.
 * @param codePage - the value `GetACP` reported.
 * @returns the label, or undefined for a code page with no decoder.
 */
function labelForCodePage(codePage: number): string | undefined {
  switch (codePage) {
    case 874: return 'windows-874'
    case 932: return 'shift_jis'
    case 936: return 'gbk'
    case 949: return 'euc-kr'
    case 950: return 'big5'
    default: return codePage >= 1250 && codePage <= 1258 ? `windows-${String(codePage)}` : undefined
  }
}

/* v8 ignore start -- Win32 code page probe; only a Windows host runs this, and POSIX lanes return undefined above. */
function probeConsoleCodePage(): ConsoleCodePage | null {
  try {
    const api = extendWin32ProcessBindings(({ kernel32, bind }) => ({
      getAcp: bind(kernel32, 'GetACP', 'uint32', []) as () => number,
    }))
    const codePage = api.getAcp()
    const decoder = decoderForCodePage(codePage)
    return decoder === undefined ? null : { codePage, decoder }
  } catch {
    // A host without the Win32 binding table keeps the UTF-8 replacement decode.
    return null
  }
}
/* v8 ignore stop */

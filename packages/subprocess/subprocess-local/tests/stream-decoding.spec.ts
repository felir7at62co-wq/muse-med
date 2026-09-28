import { isUtf8 } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OutputCollector } from '../src/output.ts'
import {
  type ConsoleCodePage,
  consoleCodePage,
  consoleCodePageFallbacks,
  decodeStreamText,
  decoderForCodePage,
} from '../src/stream-decoding.ts'

/**
 * The first two lines of the PowerShell parse error this module was written
 * for, as CP936 bytes: "所在位置 行:6 字符: 1\r\n+ ~\r\n". The whole `-Command`
 * text is parsed before `ENCODING_PREAMBLE` can pin `[Console]::OutputEncoding`,
 * so the error text itself is written in the console code page.
 */
const CP936_PARSE_ERROR = Buffer.from(
  'cbf9d4dacebbd6c320d0d03a3620d7d6b7fb3a20310d0a2b207e0d0a',
  'hex',
)

/** {@link CP936_PARSE_ERROR} decoded. */
const PARSE_ERROR_TEXT = '所在位置 行:6 字符: 1\r\n+ ~\r\n'

/** CP936 as an explicit fallback, so the code page path runs on every host. */
const CP936: ConsoleCodePage = { codePage: 936, decoder: new TextDecoder('gbk') }

const UTF8_CHINESE = Buffer.from('中文字符与 emoji 🙂 以及 ASCII', 'utf8')

/**
 * Count the replacement characters in decoded text, the defect's unit of measure.
 * @param text - decoded output text.
 * @returns the number of U+FFFD characters.
 */
function replacements(text: string): number {
  return text.split('\uFFFD').length - 1
}

describe('decodeStreamText', () => {
  it('decodes a console code page stream that is not UTF-8 at all', () => {
    // The precondition the fallback turns on: these bytes are not UTF-8.
    expect(isUtf8(CP936_PARSE_ERROR)).toBe(false)

    const text = decodeStreamText(CP936_PARSE_ERROR, CP936)

    expect(text).toBe(PARSE_ERROR_TEXT)
    expect(replacements(text)).toBe(0)
  })

  it('records every console code page decode for residual statistics', () => {
    const before = consoleCodePageFallbacks.total

    decodeStreamText(CP936_PARSE_ERROR, CP936)

    expect(consoleCodePageFallbacks.total).toBe(before + 1)
    expect(consoleCodePageFallbacks.codePage).toBe(936)
  })

  it('leaves well-formed UTF-8 byte-identical without using the fallback', () => {
    const before = consoleCodePageFallbacks.total
    const samples = ['', 'plain ascii', '中文字符', '🙂🙂', 'mixed 中文 and 🙂', 'e\u0301 combining', '中']

    for (const sample of samples) {
      const bytes = Buffer.from(sample, 'utf8')
      expect(decodeStreamText(bytes, CP936)).toBe(sample)
      expect(decodeStreamText(bytes, CP936)).toBe(bytes.toString('utf8'))
    }

    expect(consoleCodePageFallbacks.total).toBe(before)
  })

  it('keeps the replacement decode when no fallback exists', () => {
    const before = consoleCodePageFallbacks.total

    expect(decodeStreamText(CP936_PARSE_ERROR, null)).toBe(CP936_PARSE_ERROR.toString('utf8'))
    expect(replacements(decodeStreamText(CP936_PARSE_ERROR, null))).toBeGreaterThan(0)
    expect(consoleCodePageFallbacks.total).toBe(before)
  })

  it('keeps the replacement decode for a character split at the head of the window', () => {
    // The collector trims its retained head at a byte offset, so the first
    // character of the tail can be missing its lead byte.
    const cut = UTF8_CHINESE.subarray(1)
    const before = consoleCodePageFallbacks.total

    const text = decodeStreamText(cut, CP936)

    expect(text).toBe(cut.toString('utf8'))
    expect(text.endsWith('文字符与 emoji 🙂 以及 ASCII')).toBe(true)
    expect(replacements(text)).toBe(2)
    expect(consoleCodePageFallbacks.total).toBe(before)
  })

  it('keeps the replacement decode for a read holding nothing but split characters', () => {
    // An incremental read starts and ends at pipe-chunk offsets, which are
    // independent of character boundaries, so one read can hold the tail of one
    // character and the head of the next.
    const fragments = Buffer.from([0xb8, 0xad, 0xe5, 0xad])
    const headCut = UTF8_CHINESE.subarray(1, UTF8_CHINESE.length - 1)
    const before = consoleCodePageFallbacks.total

    const texts = [decodeStreamText(fragments, CP936), decodeStreamText(headCut, CP936)]

    expect(isUtf8(fragments)).toBe(false)
    expect(texts[0]).toBe(fragments.toString('utf8'))
    expect(replacements(texts[0] as string)).toBe(3)
    expect(texts[1]).toBe(headCut.toString('utf8'))
    expect(consoleCodePageFallbacks.total).toBe(before)
  })

  it('still decodes a console code page stream whose leading bytes could look like a cut', () => {
    // A CP936 lead byte followed by a CP936 trail byte is not a UTF-8 head cut:
    // a cut head is made of continuation bytes only.
    const prefixed = Buffer.concat([Buffer.from('b4ed', 'hex'), Buffer.from(': file not found', 'utf8')])

    const text = decodeStreamText(prefixed, CP936)

    expect(text).toBe('错: file not found')
    expect(replacements(text)).toBe(0)
  })

  it('decodes a lone dangling byte the same either way, since neither reading completes it', () => {
    // A one-byte window cannot hold the character it announces, so both
    // decoders yield the replacement character.
    const single = Buffer.from([0xe4])

    expect(decodeStreamText(single, CP936)).toBe(single.toString('utf8'))
    expect(decodeStreamText(single, null)).toBe('\uFFFD')
  })

  it('decodes a malformed final sequence as console text, not as a truncated one', () => {
    // 0xe4 announces three bytes but 0x41 follows it, so the tail is malformed
    // rather than cut: only an incomplete sequence is a window edge.
    const mixed = Buffer.from([0x41, 0xe4, 0x41])
    const before = consoleCodePageFallbacks.total

    expect(isUtf8(mixed)).toBe(false)
    expect(decodeStreamText(mixed, CP936)).toBe(CP936.decoder.decode(mixed))
    expect(consoleCodePageFallbacks.total).toBe(before + 1)
  })

  it('recognizes a cut tail at every UTF-8 sequence length', () => {
    const cutTails = [
      Buffer.concat([Buffer.from('a', 'utf8'), Buffer.from('中', 'utf8').subarray(0, 2)]),
      Buffer.concat([Buffer.from('a', 'utf8'), Buffer.from('中', 'utf8').subarray(0, 1)]),
      Buffer.concat([Buffer.from('a', 'utf8'), Buffer.from('🙂', 'utf8').subarray(0, 3)]),
    ]
    const before = consoleCodePageFallbacks.total

    for (const cut of cutTails) {
      expect(isUtf8(cut)).toBe(false)
      expect(decodeStreamText(cut, CP936)).toBe(cut.toString('utf8'))
    }
    expect(consoleCodePageFallbacks.total).toBe(before)
  })
})

describe('decoderForCodePage', () => {
  it('maps the Windows ANSI code pages onto their decoders', () => {
    const expected: Array<[number, string]> = [
      [874, 'windows-874'],
      [932, 'shift_jis'],
      [936, 'gbk'],
      [949, 'euc-kr'],
      [950, 'big5'],
      [1250, 'windows-1250'],
      [1252, 'windows-1252'],
      [1258, 'windows-1258'],
    ]

    for (const [codePage, encoding] of expected) {
      expect(decoderForCodePage(codePage)?.encoding).toBe(encoding)
    }
  })

  it('declines a code page with no better reading than UTF-8', () => {
    for (const codePage of [0, 437, 1249, 1259, 65001]) {
      expect(decoderForCodePage(codePage)).toBeUndefined()
    }
  })
})

describe('consoleCodePage', () => {
  it.skipIf(process.platform !== 'win32')('resolves the host ANSI code page through the number, not a locale guess', () => {
    const page = consoleCodePage()

    expect(page?.codePage).toBeGreaterThan(0)
    expect(page?.decoder.encoding).toBeTruthy()
  })

  it('settles the production decode of the parse error on a Windows console host', () => {
    if (process.platform !== 'win32') return
    const page = consoleCodePage()
    if (page?.codePage !== 936) return
    // No injected decoder: this is the path the executor's stderr takes.
    const text = decodeStreamText(CP936_PARSE_ERROR)

    expect(text).toBe(PARSE_ERROR_TEXT)
    expect(replacements(text)).toBe(0)
  })

  it('resolves no fallback off Windows', () => {
    if (process.platform === 'win32') return
    expect(consoleCodePage()).toBeUndefined()
    expect(decodeStreamText(CP936_PARSE_ERROR)).toBe(CP936_PARSE_ERROR.toString('utf8'))
  })
})

describe('OutputCollector stream decoding', () => {
  const spillDir = mkdtempSync(join(tmpdir(), 'dsh-stream-decoding-'))

  afterAll(() => { rmSync(spillDir, { recursive: true, force: true }) })

  it('keeps the replacement decode for the character its byte-exact tail cuts', () => {
    // The retained window is byte-exact, so it can begin inside a character.
    // Those bytes are not a code page stream and must not be re-read as one.
    const collector = new OutputCollector(4, 'cut-tail', { maxBytes: 100, dir: spillDir, onFailure: () => {} })
    collector.push(Buffer.from('中文', 'utf8'))
    const before = consoleCodePageFallbacks.total

    const read = collector.readFrom(0)
    const out = collector.finalize()

    expect(isUtf8(Buffer.from('中文', 'utf8').subarray(2))).toBe(false)
    expect(read.text).toBe('�文')
    expect(out.text).toBe(read.text)
    expect(consoleCodePageFallbacks.total).toBe(before)
  })

  it.runIf(consoleCodePage()?.codePage === 936)('decodes a captured console code page stream on both read paths', () => {
    const collector = new OutputCollector(64, 'parse-error', { maxBytes: 1_000, dir: spillDir, onFailure: () => {} })
    collector.push(CP936_PARSE_ERROR)

    const read = collector.readFrom(0)
    const out = collector.finalize()

    expect(read.text).toBe(PARSE_ERROR_TEXT)
    expect(out.text).toBe(PARSE_ERROR_TEXT)
    expect(replacements(out.text)).toBe(0)
  })
})

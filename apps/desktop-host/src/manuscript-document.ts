/** Bounded local manuscript extraction for revision comparisons; source files remain unchanged. */
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import { SyntaxValidator } from 'fast-xml-validator'

/** Exact source identity and extracted reading text. */
export interface ManuscriptDocument {
  path: string
  sha256: string
  text: string
}

/** Limits enforced before decompression and comparison. */
export interface DocumentLimits {
  maxFileBytes: number
  maxTextChars: number
}

/** @param path - File name. @returns Whether this reader supports its manuscript format. */
export function isManuscript(path: string): boolean {
  return ['.md', '.txt', '.docx'].includes(extname(path).toLowerCase())
}

function wordText(xml: string): string {
  if (/<!DOCTYPE|<!ENTITY/u.test(xml)) throw Error('MANUSCRIPT_INVALID_DOCX: Word 正文不接受自定义实体。')
  try { SyntaxValidator.validate(xml, { multipleRoots: false }) }
  catch (error) { throw Error('MANUSCRIPT_INVALID_DOCX: Word XML 无法解析。', { cause: error }) }
  // Revision marks need an explicit editorial decision; neither silently accept nor reject them.
  if (/<(?:\w+:)?(?:ins|del|moveFrom|moveTo)\b/u.test(xml)) {
    throw Error('MANUSCRIPT_TRACKED_CHANGES: 请先在 Word 中确认修订，再比较最终正文；源文件未改动。')
  }
  if (/<(?:\w+:)?txbxContent\b/u.test(xml)) throw Error('MANUSCRIPT_DOCX_TEXTBOX: 文本框正文暂不支持可靠排序，请另存为普通段落后比较。')
  const parsed: unknown = new XMLParser({ preserveOrder: true, ignoreAttributes: true,
    parseTagValue: false, trimValues: false, processEntities: true }).parse(xml)
  const paragraphs: string[] = []
  let paragraph = ''
  const walk = (value: unknown, inText = false): void => {
    if (!Array.isArray(value)) return
    const nodes: unknown[] = value
    for (const node of nodes) {
      if (node === null || typeof node !== 'object') continue
      for (const [key, children] of Object.entries(node)) {
        const local = key.split(':').at(-1)
        if (key === '#text') { if (inText) paragraph += String(children); continue }
        if (local === 'tab') { paragraph += '\t'; continue }
        if (local === 'noBreakHyphen') { paragraph += '\u2011'; continue }
        if (local === 'softHyphen') { paragraph += '\u00ad'; continue }
        if (local === 'br' || local === 'cr') { paragraph += '\n'; continue }
        if (local === 'p') {
          const previous = paragraph
          paragraph = ''
          walk(children)
          paragraphs.push(paragraph)
          paragraph = previous
        } else walk(children, inText || local === 't')
      }
    }
  }
  walk(parsed)
  return paragraphs.join('\n')
}

/**
 * Read Markdown, UTF-8 text, or Word main-body paragraphs including table cells.
 * @param path - Local file path; relative paths resolve from cwd.
 * @param cwd - Owning workspace, never the process launch directory.
 * @param limits - Byte and expanded-text limits.
 * @param signal - Initiating operation cancellation.
 * @returns Canonical path, exact file hash, and body text; headers, comments and text boxes are not editorial body.
 */
export async function readManuscript(path: string, cwd: string, limits: DocumentLimits,
  signal: AbortSignal): Promise<ManuscriptDocument> {
  signal.throwIfAborted()
  const absolute = resolve(cwd, path)
  if (!isManuscript(absolute)) throw Error('MANUSCRIPT_FORMAT: 仅支持 .md、.txt 和 .docx。')
  const info = await lstat(absolute)
  if (!info.isFile() || info.isSymbolicLink() || info.size > limits.maxFileBytes) {
    throw Error('MANUSCRIPT_FILE: 文稿必须是大小限制内的普通文件。')
  }
  const bytes = await readFile(absolute, { signal })
  if (bytes.length > limits.maxFileBytes) throw Error('MANUSCRIPT_SIZE: 文件读取期间超出大小限制。')
  let text: string
  if (extname(absolute).toLowerCase() === '.docx') {
    let expanded = 0
    const parts = unzipSync(bytes, { filter(entry) {
      if (entry.name !== 'word/document.xml') return false
      expanded += entry.originalSize
      if (expanded > limits.maxTextChars * 8) throw Error('MANUSCRIPT_SIZE: Word 正文解压后过大。')
      return true
    } })
    const document = parts['word/document.xml']
    if (document === undefined) throw Error('MANUSCRIPT_INVALID_DOCX: 缺少 Word 正文。')
    text = wordText(strFromU8(document))
  } else text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text.length > limits.maxTextChars) throw Error('MANUSCRIPT_SIZE: 文稿过长，请按实际分集比较，不截断检查。')
  signal.throwIfAborted()
  return { path: await realpath(absolute), sha256: createHash('sha256').update(bytes).digest('hex'), text }
}

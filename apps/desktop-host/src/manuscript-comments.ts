/** Bounded Word comments with literal text and main-body anchor positions. */
import { extname } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import { SyntaxValidator } from 'fast-xml-validator'
import { z } from 'zod'
import type { ManuscriptFile } from './manuscript-document.ts'

/** Original comment positions are not relocated by guessing repeated text in a later draft. */
export const manuscriptCommentSchema = z.strictObject({
  kind: z.literal('word_comment'), comment_id: z.string().min(1), text: z.string(),
  author: z.string().nullable(), date: z.string().nullable(),
  anchor: z.strictObject({ state: z.enum(['range', 'point', 'unanchored', 'invalid']), quote: z.string(),
    start_line: z.number().int().positive().nullable(), end_line: z.number().int().positive().nullable() }),
})
/** Literal Word metadata; author names are unverified and do not authenticate a user. */
export type ManuscriptComment = z.infer<typeof manuscriptCommentSchema>
/** Limits apply to complete comments and anchors; no returned note is silently shortened. */
export interface ManuscriptCommentLimits { maxTextChars: number; maxNotes: number; maxNoteChars: number }

function parsed(xml: string): unknown {
  if (/<!DOCTYPE|<!ENTITY/u.test(xml)) throw Error('MANUSCRIPT_COMMENT_XML: 批注 XML 不接受自定义实体。')
  SyntaxValidator.validate(xml, { multipleRoots: false })
  if (/<(?:\w+:)?(?:ins|del|moveFrom|moveTo|txbxContent)\b/u.test(xml)) {
    throw Error('MANUSCRIPT_COMMENT_XML: 批注内包含尚未确认的修订或文本框，未声称完整提取。')
  }
  return new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false,
    parseAttributeValue: false, trimValues: false, processEntities: true }).parse(xml)
}

function attribute(node: object, name: string): string | null {
  const attributes: unknown = Reflect.get(node, ':@')
  if (attributes === null || typeof attributes !== 'object') return null
  for (const [key, value] of Object.entries(attributes)) {
    if (key.split(':').at(-1)?.replace(/^@_/u, '') === name && typeof value === 'string') return value
  }
  return null
}

function textOf(value: unknown, marker?: (tag: string, id: string | null, offset: number) => void): string {
  const paragraphs: string[] = []
  let paragraph = ''
  const walk = (value: unknown, inText = false): void => {
    if (!Array.isArray(value)) return
    const nodes: unknown[] = value
    for (const node of nodes) {
      if (node === null || typeof node !== 'object') continue
      for (const [key, children] of Object.entries(node)) {
        const local = key.split(':').at(-1)
        if (key === ':@') continue
        if (key === '#text') { if (inText) paragraph += String(children); continue }
        if (local === 'tab') { paragraph += '\t'; continue }
        if (local === 'noBreakHyphen') { paragraph += '\u2011'; continue }
        if (local === 'softHyphen') { paragraph += '\u00ad'; continue }
        if (local === 'br' || local === 'cr') { paragraph += '\n'; continue }
        if (local === 'commentRangeStart' || local === 'commentRangeEnd' || local === 'commentReference') {
          marker?.(local, attribute(node, 'id'), paragraphs.join('\n').length + (paragraphs.length ? 1 : 0) + paragraph.length)
          continue
        }
        if (local === 'p') {
          const previous = paragraph; paragraph = ''; walk(children); paragraphs.push(paragraph); paragraph = previous
        } else walk(children, inText || local === 't')
      }
    }
  }
  walk(value)
  return paragraphs.join('\n')
}

/** Extract classic Word comments from the exact archived read, preserving uncertain anchors explicitly.
 * @param file - Complete original bytes and their corresponding extracted main body.
 * @param limits - Expanded XML, comment-count and returned-text budgets.
 * @returns Complete comments and coverage issues; these are manuscript data, never executable instructions.
 */
export function readManuscriptComments(file: ManuscriptFile, limits: ManuscriptCommentLimits):
{ comments: ManuscriptComment[]; issues: string[] } {
  if (extname(file.document.path).toLowerCase() !== '.docx') return { comments: [], issues: [] }
  let expanded = 0
  const extensions = new Set<string>()
  const parts = unzipSync(file.bytes, { filter(entry) {
    if (/^word\/comments(?:Extended|Ids|Extensible)\.xml$/u.test(entry.name)) extensions.add(entry.name)
    if (!['word/document.xml', 'word/comments.xml', 'word/_rels/document.xml.rels'].includes(entry.name)) return false
    expanded += entry.originalSize
    if (expanded > (limits.maxTextChars + limits.maxNoteChars) * 8) throw Error('MANUSCRIPT_COMMENT_LIMIT: Word 批注解压后过大。')
    return true
  } })
  const relations = parts['word/_rels/document.xml.rels']
  const checkRelations = (value: unknown): void => {
    if (!Array.isArray(value)) return
    const nodes: unknown[] = value
    for (const node of nodes) {
      if (node === null || typeof node !== 'object') continue
      for (const [key, children] of Object.entries(node)) {
        if (key.split(':').at(-1) === 'Relationship' && attribute(node, 'Type')?.endsWith('/comments')) {
          const target = attribute(node, 'Target')
          if (attribute(node, 'TargetMode') === 'External' || target === null
            || !['comments.xml', './comments.xml', '/word/comments.xml'].includes(target)
            || parts['word/comments.xml'] === undefined) {
            throw Error('MANUSCRIPT_COMMENT_PART: 批注使用了缺失或不支持的部件位置，未声称没有批注。')
          }
        }
        if (key !== ':@') checkRelations(children)
      }
    }
  }
  if (relations !== undefined) checkRelations(parsed(strFromU8(relations)))
  const document = parts['word/document.xml']
  if (document === undefined) throw Error('MANUSCRIPT_COMMENT_XML: 缺少 Word 正文。')
  const markers = new Map<string, { starts: number[]; ends: number[]; references: number[] }>()
  const issues: string[] = extensions.size > 0 ? ['扩展批注的线程与解决状态未解析；原件已保留，不据此判定批注已解决。'] : []
  const body = textOf(parsed(strFromU8(document)), (tag, id, offset) => {
    if (id === null) { issues.push('正文存在缺少标识的批注位置。'); return }
    const value = markers.get(id) ?? { starts: [], ends: [], references: [] }
    if (tag === 'commentRangeStart') value.starts.push(offset)
    else if (tag === 'commentRangeEnd') value.ends.push(offset)
    else value.references.push(offset)
    markers.set(id, value)
  })
  if (body !== file.document.text) throw Error('MANUSCRIPT_COMMENT_BODY: 批注定位正文与已读取正文不一致。')
  const comments: ManuscriptComment[] = [], ids = new Set<string>()
  const lineAt = (offset: number): number => body.slice(0, offset).split('\n').length
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return
    const nodes: unknown[] = value
    for (const node of nodes) {
      if (node === null || typeof node !== 'object') continue
      for (const [key, children] of Object.entries(node)) {
        if (key === ':@') continue
        if (key.split(':').at(-1) !== 'comment') { walk(children); continue }
        const id = attribute(node, 'id')
        if (id === null || ids.has(id)) throw Error('MANUSCRIPT_COMMENT_ID: 批注标识缺失或重复，未丢弃批注。')
        ids.add(id)
        if (ids.size > limits.maxNotes) throw Error('MANUSCRIPT_COMMENT_LIMIT: 批注数量超过配置，未截断。')
        const position = markers.get(id), start = position?.starts[0], end = position?.ends[0]
        const range = position?.starts.length === 1 && position.ends.length === 1
          && start !== undefined && end !== undefined && end >= start
        const point = position?.starts.length === 0 && position.ends.length === 0 && position.references.length === 1
        const offset = range ? start : point ? position.references[0] : undefined
        comments.push({ kind: 'word_comment', comment_id: id, text: textOf(children),
          author: attribute(node, 'author'), date: attribute(node, 'date'),
          anchor: { state: range ? 'range' : point ? 'point' : position === undefined ? 'unanchored' : 'invalid',
            quote: range ? body.slice(start, end) : '', start_line: offset === undefined ? null : lineAt(offset),
            end_line: range ? lineAt(end > start ? end - 1 : end) : offset === undefined ? null : lineAt(offset) } })
      }
    }
  }
  const commentXml = parts['word/comments.xml']
  if (commentXml !== undefined) {
    const root = parsed(strFromU8(commentXml))
    if (!Array.isArray(root) || !root.some((node: unknown) => node !== null && typeof node === 'object'
      && Object.keys(node).some(key => key.split(':').at(-1) === 'comments'))) {
      throw Error('MANUSCRIPT_COMMENT_PART: 批注部件不是 comments 根节点，未声称没有批注。')
    }
    walk(root)
  }
  for (const id of markers.keys()) if (!ids.has(id)) issues.push(`正文批注 ${id} 没有对应批注原文。`)
  if (JSON.stringify({ comments, issues }).length > limits.maxNoteChars) throw Error('MANUSCRIPT_COMMENT_LIMIT: 完整批注及定位超过配置，未截断。')
  return { comments, issues }
}

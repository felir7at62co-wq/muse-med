/** Word comments retain literal text and uncertain source positions without relocating later drafts. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, expect, it } from 'vitest'
import { readManuscriptComments } from '../src/manuscript-comments.ts'
import { readManuscriptFile } from '../src/manuscript-document.ts'

const roots: string[] = [], signal = new AbortController().signal
const limits = { maxFileBytes: 65536, maxTextChars: 20000, maxNotes: 16, maxNoteChars: 20000 }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function extract(body: string, comments?: string, extra: Record<string, Uint8Array> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-comments-')); roots.push(root)
  const bytes = zipSync({ 'word/document.xml': strToU8(`<w:document xmlns:w="urn:test"><w:body>${body}</w:body></w:document>`),
    ...comments === undefined ? {} : { 'word/comments.xml': strToU8(`<w:comments xmlns:w="urn:test">${comments}</w:comments>`) }, ...extra })
  await writeFile(join(root, '原稿.docx'), bytes)
  const file = await readManuscriptFile('原稿.docx', root, limits, signal)
  return { file, result: () => readManuscriptComments(file, limits) }
}
const note = (id: string, text: string) => `<w:comment w:id="${id}" w:author="审稿人" w:date="2026-11-09T01:00:00Z"><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:comment>`

it('keeps exact comment text, unverified author and a multi-paragraph anchor including a table cell', async () => {
  const f = await extract('<w:p><w:r><w:t>第1集</w:t></w:r></w:p><w:p><w:r><w:t>甲：</w:t></w:r><w:commentRangeStart w:id="0"/>'
    + '<w:r><w:t>死死抓住</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>这一次的重复动作。</w:t></w:r><w:commentRangeEnd w:id="0"/>'
    + '<w:r><w:commentReference w:id="0"/></w:r></w:p></w:tc></w:tr></w:tbl>', note('0', '删掉这里的重复动作；不要删后面的解释。'))
  expect(f.result()).toEqual({ issues: [], comments: [{ kind: 'word_comment', comment_id: '0',
    author: '审稿人', date: '2026-11-09T01:00:00Z', text: '删掉这里的重复动作；不要删后面的解释。',
    anchor: { state: 'range', quote: '死死抓住\n这一次的重复动作。', start_line: 2, end_line: 3 } }] })
})

it('distinguishes point, missing and broken anchors rather than finding similar later text', async () => {
  const f = await extract('<w:p><w:r><w:t>甲：我不会走。</w:t><w:commentReference w:id="0"/></w:r><w:commentRangeStart w:id="2"/></w:p>',
    note('0', '点批注') + note('1', '未定位批注') + note('2', '缺结束位置'))
  expect(f.result().comments.map(comment => comment.anchor)).toEqual([
    { state: 'point', quote: '', start_line: 1, end_line: 1 },
    { state: 'unanchored', quote: '', start_line: null, end_line: null },
    { state: 'invalid', quote: '', start_line: null, end_line: null },
  ])
})

it('reports absent comment parts and unsupported threaded status without treating them as resolved', async () => {
  const f = await extract('<w:p><w:r><w:commentReference w:id="7"/></w:r></w:p>', undefined,
    { 'word/commentsExtended.xml': strToU8('<w:commentsEx/>') })
  expect(f.result()).toEqual({ comments: [], issues: ['扩展批注的线程与解决状态未解析；原件已保留，不据此判定批注已解决。', '正文批注 7 没有对应批注原文。'] })
})

it('refuses duplicate comment ids, XML entities and alternate comment parts instead of dropping data', async () => {
  const duplicate = await extract('<w:p/>', note('0', '甲') + note('0', '乙'))
  expect(duplicate.result).toThrow('COMMENT_ID')
  const entity = await extract('<w:p/>', '<!DOCTYPE x [<!ENTITY x "text">]>' + note('0', '&amp;'))
  expect(entity.result).toThrow('COMMENT_XML')
  const alternate = await extract('<w:p/>', undefined, { 'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship Type="urn:test/comments" Target="other.xml"/></Relationships>') })
  expect(alternate.result).toThrow('COMMENT_PART')
  const orphan = await extract('<w:p/>', note('0', '未被关系引用的部件'), { 'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship Type="urn:test/comments" Target="other.xml"/></Relationships>') })
  expect(orphan.result).toThrow('COMMENT_PART')
  const wrongRoot = await extract('<w:p/>', undefined, { 'word/comments.xml': strToU8('<w:commentsEx xmlns:w="urn:test"/>') })
  expect(wrongRoot.result).toThrow('COMMENT_PART')
})

it('rejects count and complete-text overflow without returning a shortened comment', async () => {
  const f = await extract('<w:p/>', note('0', '甲') + note('1', '乙'))
  expect(() => readManuscriptComments(f.file, { ...limits, maxNotes: 1 })).toThrow('COMMENT_LIMIT')
  expect(() => readManuscriptComments(f.file, { ...limits, maxNoteChars: 1 })).toThrow('COMMENT_LIMIT')
})

/** Exact original bytes survive source edits, restarts, concurrent captures and storage refusal. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { strToU8, zipSync } from 'fflate'
import { Config } from '../src/manuscript-revisions.ts'
import { ManuscriptVersions, snapshotManuscripts } from '../src/manuscript-versions.ts'
import { readManuscript } from '../src/manuscript-document.ts'

const roots: string[] = [], signal = new AbortController().signal, session = SessionId('version-owner')
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'muse-version-')); roots.push(root)
  return { root, config: Config({}) }
}

it('retains complete annotated Word bytes and formatting after the selected source is replaced', async () => {
  const { root, config } = await fixture()
  const original = zipSync({
    'word/document.xml': strToU8('<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>甲：保留这一句。</w:t></w:r></w:p></w:body></w:document>'),
    'word/comments.xml': strToU8('<w:comments xmlns:w="urn:test"><w:comment w:id="1"><w:p><w:r><w:t>第三集不要动。</w:t></w:r></w:p></w:comment></w:comments>'),
    'word/styles.xml': strToU8('<w:styles xmlns:w="urn:test"/>'),
  })
  await writeFile(join(root, '返稿.docx'), original)
  const [version] = await snapshotManuscripts(['返稿.docx'], root, config, session, signal)
  expect(version).toBeDefined()
  if (!version) throw Error('Expected captured original')
  expect(await readFile(version.snapshot_path)).toEqual(Buffer.from(original))
  await writeFile(join(root, '返稿.docx'), 'new bytes')
  const history = await new ManuscriptVersions(config).history(['返稿.docx'], root, signal)
  expect(history).toEqual([version])
  expect((await readManuscript(version.snapshot_path, root, config, signal)).text).toBe('甲：保留这一句。')
  expect(await readFile(join(root, '返稿.docx'), 'utf8')).toBe('new bytes')
})

it('preserves successive versions and finds them after the current file has been removed', async () => {
  const { root, config } = await fixture()
  await writeFile(join(root, '稿件.md'), '第1集\n甲：原句。')
  const first = await snapshotManuscripts(['稿件.md'], root, config, session, signal)
  await writeFile(join(root, '稿件.md'), '第1集\n甲：新句。')
  const second = await snapshotManuscripts(['稿件.md'], root, config, session, signal)
  await rm(join(root, '稿件.md'))
  const versions = await new ManuscriptVersions(config).history(['稿件.md'], root, signal)
  expect(versions).toEqual([...first, ...second])
  expect(await readFile(versions[0]!.snapshot_path, 'utf8')).toContain('原句')
  expect(await readFile(versions[1]!.snapshot_path, 'utf8')).toContain('新句')
})

it('reuses one original for identical bytes while keeping explicit source associations', async () => {
  const { root, config } = await fixture()
  await writeFile(join(root, 'a.md'), '甲：保留。'); await writeFile(join(root, 'b.md'), '甲：保留。')
  const first = await snapshotManuscripts(['a.md', 'b.md'], root, config, session, signal)
  expect(first[0]?.snapshot_path).toBe(first[1]?.snapshot_path)
  expect(await snapshotManuscripts(['a.md'], root, config, session, signal)).toEqual([first[0]])
  expect(await new ManuscriptVersions(config).history(['a.md', 'b.md'], root, signal)).toHaveLength(2)
  await expect(snapshotManuscripts(['a.md', './a.md'], root, config, session, signal)).rejects.toThrow('DUPLICATE_PATH')
})

it('refuses capacity overflow without deleting or replacing an older version', async () => {
  const { root, config } = await fixture()
  const limited = Config({ maxVersions: 1 })
  await writeFile(join(root, 'a.md'), '旧稿')
  const [first] = await snapshotManuscripts(['a.md'], root, limited, session, signal)
  await writeFile(join(root, 'a.md'), '新稿')
  await expect(snapshotManuscripts(['a.md'], root, limited, session, signal)).rejects.toThrow('VERSION_LIMIT')
  expect(await new ManuscriptVersions(config).history(['a.md'], root, signal)).toEqual([first])
  expect(await readFile(first!.snapshot_path, 'utf8')).toBe('旧稿')
  const bytesLimited = Config({ maxVersionBytes: Buffer.byteLength('旧稿') })
  await expect(snapshotManuscripts(['a.md'], root, bytesLimited, session, signal)).rejects.toThrow('VERSION_SIZE')
})

it('detects damaged historical bytes rather than silently repairing them from the current source', async () => {
  const { root, config } = await fixture()
  await writeFile(join(root, 'a.md'), '甲：原句。')
  const [version] = await snapshotManuscripts(['a.md'], root, config, session, signal)
  await writeFile(version!.snapshot_path, 'unexpected')
  await expect(new ManuscriptVersions(config).history(['a.md'], root, signal)).rejects.toThrow('VERSION_CHANGED')
  await expect(snapshotManuscripts(['a.md'], root, config, session, signal)).rejects.toThrow('VERSION_CHANGED')
  expect(await readFile(version!.snapshot_path, 'utf8')).toBe('unexpected')
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('甲：原句。')
})

it('serializes independent history owners without losing any captured versions', async () => {
  const { root, config } = await fixture()
  const names = Array.from({ length: 6 }, (_, i) => `episode-${i}.md`)
  await Promise.all(names.map((name, i) => writeFile(join(root, name), `第${i + 1}集\n甲：第${i + 1}句。`)))
  await Promise.all(names.map(name => snapshotManuscripts([name], root, config, session, signal)))
  expect(await new ManuscriptVersions(config).history(names, root, signal)).toHaveLength(6)
  expect((await readdir(join(root, '.muse/manuscript-revisions/versions'))).filter(name => name.endsWith('.tmp'))).toEqual([])
})

it('does not capture an unsupported or cancelled source', async () => {
  const { root, config } = await fixture()
  await writeFile(join(root, 'a.md'), '甲：原句。')
  const cancelled = new AbortController(); cancelled.abort()
  await expect(snapshotManuscripts(['a.md'], root, config, session, cancelled.signal)).rejects.toThrow()
  expect(await new ManuscriptVersions(config).history(['a.md'], root, signal)).toEqual([])
  await expect(snapshotManuscripts(['a.exe'], root, config, session, signal)).rejects.toThrow('MANUSCRIPT_FORMAT')
})

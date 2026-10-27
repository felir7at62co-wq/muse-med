/** Project evidence rejects invalid references, stale media and text that cannot support literal quotations. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { groundStory, parseStoryEvidence, type StoryEvidenceReference } from '../src/story-evidence.ts'

const growth = vi.hoisted(() => ({ file: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (args[0] === growth.file) {
      growth.file = ''
      await actual.appendFile(args[0], Buffer.alloc(2 * 1024 * 1024))
    }
    return await actual.readFile(...args)
  } }
})
const roots: string[] = []
afterEach(async () => {
  growth.file = ''
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bgm-evidence-'))
  roots.push(root)
  return root
}
const reference: StoryEvidenceReference = { kind: 'script', file: 'script.txt', quotes: ['real action'] }
const signal = () => new AbortController().signal

it.each([
  null, [], Array(9).fill(reference), [null], [[]], [{ ...reference, kind: 'guess' }],
  [{ ...reference, file: ' ' }], [{ ...reference, quotes: [] }], [{ ...reference, quotes: 'real action' }],
  [{ ...reference, quotes: Array(9).fill('action') }], [{ ...reference, quotes: [1] }],
  [{ ...reference, quotes: [' '] }], [{ ...reference, quotes: ['字'.repeat(801)] }],
])('rejects malformed source references: %j', (value) => {
  expect(() => parseStoryEvidence(value)).toThrow(/evidence|Evidence/)
})

it('preserves bounded Unicode quotes and distinguishes optional evidence from verified evidence', async () => {
  expect(parseStoryEvidence(undefined)).toBeUndefined()
  const refs = [{ ...reference, quotes: ['字'.repeat(800)] }]
  expect(parseStoryEvidence(refs)).toEqual(refs)
  expect(await groundStory(undefined, undefined, false, signal())).toMatchObject({ status: 'missing_evidence', missing_kinds: [] })
  await expect(groundStory(' ', [reference], false, signal())).rejects.toThrow('requires project')
})

it('matches whitespace-independent transcript quotes against the actual UTF-8 bytes', async () => {
  const root = await fixture()
  const bytes = Buffer.from('real\n action\n对白')
  await writeFile(join(root, 'script.txt'), bytes)
  expect(await groundStory(root, [{ ...reference, kind: 'transcript' }], false, signal())).toMatchObject({
    status: 'quotes_matched', sources: [{ kind: 'transcript',
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, quotes: [{ found: true }] }],
  })
  await expect(groundStory(root, [reference], false, AbortSignal.abort())).rejects.toThrow()
  await expect(groundStory(root, undefined, false, AbortSignal.abort())).rejects.toThrow()
})

it('rejects directories, oversized text and invalid UTF-8 without treating them as evidence', async () => {
  const root = await fixture()
  await mkdir(join(root, 'script.txt'))
  await expect(groundStory(root, [reference], false, signal())).rejects.toThrow('UTF-8 text file')
  await rm(join(root, 'script.txt'), { recursive: true })
  await writeFile(join(root, 'script.txt'), Buffer.alloc(2 * 1024 * 1024 + 1))
  await expect(groundStory(root, [reference], false, signal())).rejects.toThrow('at most 2 MiB')
  await writeFile(join(root, 'script.txt'), Buffer.from([0xff]))
  await expect(groundStory(root, [reference], false, signal())).rejects.toThrow()
})

it('enforces the byte bound again when a source grows after stat', async () => {
  const root = await fixture()
  await writeFile(join(root, 'script.txt'), 'real action')
  growth.file = join(root, 'script.txt')
  await expect(groundStory(root, [reference], false, signal())).rejects.toThrow('exceeds 2 MiB')
  expect((await readFile(join(root, 'script.txt'))).length).toBeGreaterThan(2 * 1024 * 1024)
})

it.each([
  null, [], {}, { video: '', video_sha256: 'a'.repeat(64), observations: 'observed' },
  { video: 'video.mp4', video_sha256: 'bad', observations: 'observed' },
  { video: 'video.mp4', video_sha256: 'a'.repeat(64), observations: ' ' },
])('rejects incomplete visual-review records: %j', async (value) => {
  const root = await fixture()
  await writeFile(join(root, 'review.json'), JSON.stringify(value))
  await expect(groundStory(root, [{ kind: 'visual_review', file: 'review.json', quotes: ['observed'] }], false, signal()))
    .rejects.toThrow('visual_review')
})

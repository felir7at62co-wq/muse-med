/** Bind quoted selection facts to current project text without claiming semantic or audiovisual approval. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

/** A bounded quotation from the script, transcript or a recorded visual inspection. */
export type StoryEvidenceReference = {
  kind: 'script' | 'transcript' | 'visual_review'
  file: string
  quotes: string[]
}

/** Current file identities and literal quote checks, without a story-suitability verdict. */
export type StoryGrounding = {
  status: 'quotes_matched' | 'missing_evidence' | 'quote_mismatch' | 'video_changed'
  missing_kinds: string[]
  sources: {
    kind: StoryEvidenceReference['kind']
    file: string
    sha256: string
    video?: { file: string; sha256: string; matches_record: boolean }
    quotes: { quote: string; found: boolean }[]
  }[]
  notice: string
}

async function projectFile(root: string, candidate: string): Promise<string> {
  const file = await realpath(resolve(root, candidate))
  const rel = relative(root, file)
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error('story.evidence file and video must stay inside the project')
  }
  return file
}

async function visualReview(root: string, text: string, signal: AbortSignal): Promise<{
  text: string
  video: NonNullable<StoryGrounding['sources'][number]['video']>
}> {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('visual_review must be a JSON record')
  const row = value as Record<string, unknown>
  if (typeof row.video !== 'string' || !row.video.trim() || typeof row.video_sha256 !== 'string'
    || !/^(?:sha256:)?[a-f0-9]{64}$/iu.test(row.video_sha256)
    || typeof row.observations !== 'string' || !row.observations.trim()) {
    throw new Error('visual_review requires video, video_sha256 and observations from actual inspection')
  }
  const file = await projectFile(root, row.video)
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file, { signal }) as AsyncIterable<Buffer>) {
    digest.update(chunk)
  }
  const sha256 = `sha256:${digest.digest('hex')}`
  return { text: row.observations, video: { file, sha256,
    matches_record: sha256 === `sha256:${row.video_sha256.replace(/^sha256:/iu, '').toLowerCase()}` } }
}

/** Validate bounded references from tool JSON.
 * @param value - Optional evidence array supplied with a story request.
 * @returns Explicit references, or undefined when omitted.
 * @throws When references, kinds or quotes exceed the accepted request format.
 */
export function parseStoryEvidence(value: unknown): StoryEvidenceReference[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) throw new Error('story.evidence requires 1–8 text references')
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('story.evidence entry must be an object')
    const row = entry as Record<string, unknown>
    if (row.kind !== 'script' && row.kind !== 'transcript' && row.kind !== 'visual_review') throw new Error('Invalid story.evidence kind')
    if (typeof row.file !== 'string' || !row.file.trim()) throw new Error('story.evidence.file must name a project text file')
    if (!Array.isArray(row.quotes) || row.quotes.length === 0 || row.quotes.length > 8) throw new Error('story.evidence.quotes requires 1–8 quotes')
    const quotes = row.quotes.map((quote: unknown) => {
      if (typeof quote !== 'string' || !quote.trim() || Array.from(quote).length > 800) throw new Error('Evidence quotes must contain 1–800 characters')
      return quote
    })
    return { kind: row.kind, file: row.file, quotes }
  })
}

/** Read every reference anew and compare quotes with current UTF-8 source text.
 * @param project - Project root required when references are supplied.
 * @param references - Script and observed-picture notes, with optional transcript evidence.
 * @param required - Whether both script and visual-review evidence are required.
 * @param signal - Cancellation of the current match operation.
 * @returns Literal evidence checks; hashes identify bytes, not the accuracy of a visual note.
 * @throws When project files are missing, outside the project, oversized or invalid UTF-8/JSON, or the call is cancelled.
 */
export async function groundStory(
  project: string | undefined, references: readonly StoryEvidenceReference[] | undefined,
  required: boolean, signal: AbortSignal,
): Promise<StoryGrounding> {
  const kinds = new Set(references?.map(row => row.kind))
  const requiredKinds: StoryEvidenceReference['kind'][] = ['script', 'visual_review']
  const missing = required ? requiredKinds.filter(kind => !kinds.has(kind)) : []
  const sources: StoryGrounding['sources'] = []
  if (references?.length) {
    if (!project?.trim()) throw new Error('story.evidence requires project')
    const root = await realpath(resolve(project))
    for (const ref of references) {
      signal.throwIfAborted()
      const file = await projectFile(root, ref.file)
      const info = await stat(file)
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Evidence must be a UTF-8 text file of at most 2 MiB')
      const bytes = await readFile(file, { signal })
      if (bytes.length > 2 * 1024 * 1024) throw new Error('Evidence exceeds 2 MiB')
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const visual = ref.kind === 'visual_review' ? await visualReview(root, raw, signal) : undefined
      const text = (visual?.text ?? raw).replace(/\s+/gu, '')
      sources.push({ kind: ref.kind, file, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        ...(visual === undefined ? {} : { video: visual.video }),
        quotes: ref.quotes.map(quote => ({ quote, found: text.includes(quote.replace(/\s+/gu, '')) })) })
    }
  }
  signal.throwIfAborted()
  return { status: sources.some(source => source.quotes.some(quote => !quote.found)) ? 'quote_mismatch'
    : sources.some(source => source.video?.matches_record === false) ? 'video_changed'
      : missing.length || !sources.length ? 'missing_evidence' : 'quotes_matched',
  missing_kinds: missing, sources,
  notice: 'Literal quotes and the visual record’s video hash are checked. These checks do not establish narrative interpretation, visual-note accuracy, audio audition or musical suitability.' }
}

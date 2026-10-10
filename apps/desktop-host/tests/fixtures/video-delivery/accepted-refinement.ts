/** Original synthetic precision-edit fixture; this is not a Host authorization test. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acceptedScripts, PROJECT_FILE, sha256 } from '@deepseek-ai/dsh-screenplay-project'
import { candidateDigest } from '../../../../../packages/drama/screenplay-project/src/episode.ts'
import { buildRefinement, refinementPolicyDigest } from '../../../../../packages/drama/screenplay-project/src/refinement.ts'
import { factDigest } from '../../../../../packages/drama/screenplay-project/src/review.ts'
import { acceptedVideo } from './accepted-video.ts'

/**
 * Build accepted synthetic source-preserving output with a separate report.
 * @param root - Empty fixture directory.
 * @param video - Retain the video workflow marker; false tests non-video precision edits.
 * @returns Pure screenplay, report, project, and unchanged source baseline paths.
 */
export async function acceptedRefinement(root: string, video = true) {
  const originalRoot = join(root, 'original'), branch = join(root, 'refined')
  await mkdir(originalRoot); await mkdir(branch); await mkdir(join(branch, 'qa')); await mkdir(join(branch, 'final'))
  const original = await acceptedVideo(originalRoot)
  if (!video) {
    delete original.project.workflow
    original.project.sources.splice(1)
    const unit = original.project.sources[0]!.units[0]!
    const indexed = PROJECT_FILE.parse({ ...original.project,
      sources: [{ ...original.project.sources[0]!, units: [{ ...unit, id: `${original.project.sources[0]!.id}:u1` }] }],
    }).sources[0]!.units[0]!
    original.project.sources[0]!.units[0] = indexed
    original.project.facts[0]!.anchors[0]!.unit_id = indexed.id
    original.project.candidates[0]!.coverage!.windows.splice(1)
    original.project.candidates[0]!.sha256 = candidateDigest(original.project.candidates[0]!)
    await writeFile(original.projectPath, JSON.stringify(original.project))
  }
  const baseline = original.project.candidates[0]!
  const project = PROJECT_FILE.parse({ ...original.project, id: 'p:refined-fixture', revision: 3, candidates: [], accepted: [],
    refinement: { version: 'source-preserving-v1', sha256: '0'.repeat(64),
      source_project: { id: original.project.id, path: original.projectPath, revision: original.project.revision,
        sha256: sha256(await readFile(original.projectPath)) },
      baselines: [structuredClone(baseline)], retained_candidates: [],
      original_facts: original.project.facts.map(fact => ({ id: fact.id, sha256: factDigest(fact) })),
      original_sources: original.project.sources.map(source => ({ id: source.id, sha256: sha256(JSON.stringify(source)) })),
      scope: { episodes: [1], instructions: '第一集仅顺句，不改变剧情事实、人物和来源归属。' }, allowed_categories: [],
      authorization: { source: 'user', session_id: 'editor', message_id: 'synthetic-human-message', seq: 4,
        message_sha256: sha256('仅第一集顺句。'), quote: '仅第一集顺句。', consent_assessment: '合成夹具的有界表达授权。' } } })
  project.refinement!.sha256 = refinementPolicyDigest(project.refinement!)
  const candidate = PROJECT_FILE.parse({ ...project, candidates: [{ ...structuredClone(baseline),
    id: 'c:22222222-2222-4222-8222-222222222222', author: 'editor', review: undefined, committed_at: undefined }] }).candidates[0]!
  candidate.scenes[0]!.beats[0]!.text = '你好呀。'
  candidate.refinement = buildRefinement(project, candidate, {
    changes: [{ before: { scene: 1, beat: 1, text: '你好。' }, after: { scene: 1, beat: 1, text: '你好呀。' }, reason: '小幅顺句，保持问候立场。' }],
    editor_comments: [{ comment: '问候略顺口。', disposition: 'adopted', reason: '仅补语气词。', change_indices: [1] }],
    unresolved: ['实际表演及画面同步未核实。'], unhandled: [], validation: {
      semantic: { status: 'limited', scenes: [1], reason: '合成夹具仅核对问候立场，未验证完整剧情。' },
      visual: { status: 'not_run', source_units: [], reason: '本测试不进行视觉审核。' } } })
  candidate.sha256 = candidateDigest(candidate)
  candidate.review = { actor: baseline.review!.actor, time: baseline.created_at, decision: 'approve',
    reason: '合成夹具独立审核，真实单模型分轮在核心 Loader 测试。', zero_action_reason: baseline.review!.zero_action_reason }
  candidate.committed_at = baseline.created_at
  project.candidates.push(candidate); project.accepted.push(candidate.id)
  const projectPath = join(branch, 'qa', 'screenplay-project.json')
  await writeFile(projectPath, JSON.stringify(project))
  const rendered = acceptedScripts(project)[0]!
  if (rendered.modification_notes === undefined) throw Error('Synthetic precision-edit report is missing')
  const input = join(branch, 'final', 'accepted.md'), report = join(branch, 'final', 'modification-notes.md')
  await writeFile(input, rendered.script); await writeFile(report, rendered.modification_notes)
  return { project, projectPath, input, report, rendered, original }
}

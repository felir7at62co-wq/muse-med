/** Fixed accepted source inventory for offline delivery regression. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acceptedScripts, PROJECT_FILE, sha256 } from '@deepseek-ai/dsh-screenplay-project'

export async function acceptedVideo(root: string) {
  await mkdir(join(root, 'qa')); await mkdir(join(root, 'final'))
  const source = join(root, 'speech.txt'), frames = join(root, 'frames.json'), projectPath = join(root, 'qa', 'screenplay-project.json')
  await writeFile(source, '你好。'); await writeFile(frames, 'Fixed visual source inventory')
  const now = '2026-10-09T00:00:00.000Z'
  const scenes = [{ location: '门口', time: '日', setting: '内', layer: 'present', transition: 'opening', characters: ['甲'],
    beats: [{ kind: 'dialogue', actor: '甲', text: '你好。', fact_ids: ['f:speech'], requires_knowledge: [], witnesses: [] }] }]
  const coverage = { windows: [{ source_id: 's:speech', start: 1, count: 1 }, { source_id: 's:visual', start: 1, count: 1 }],
    required_beats: [{ fact_id: 'f:speech', kind: 'dialogue' }] }
  const project = PROJECT_FILE.parse({
    format_version: 1, id: 'p:accepted-fixture', revision: 6, mode: 'faithful', workflow: 'video_to_screenplay',
    instructions: '固定无动作素材，独立复核后保留对白。', created_at: now, updated_at: now,
    sources: [{ id: 's:speech', path: source, sha256: sha256('你好。'), kind: 'text', units: [{ id: 'u:speech', ordinal: 1, text: '你好。' }] },
      { id: 's:visual', path: frames, sha256: sha256('Fixed visual source inventory'), kind: 'video_inspection',
        units: [{ id: 'u:visual', ordinal: 1, text: '固定图像引用', image: { attachmentId: 'fixture-frame', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }] }],
    facts: [{ id: 'f:speech', actor: '甲', kind: 'speech', origin: 'source', layer: 'present', summary: '你好。',
      anchors: [{ unit_id: 'u:speech', quote: '你好。' }], proposer: 'writer', created_at: now,
      review: { actor: 'reviewer', time: now, decision: 'approve', reason: '固定来源核对。' } }],
    candidates: [{ id: 'c:11111111-1111-4111-8111-111111111111', sha256: sha256(JSON.stringify({ episode: 1, scenes, coverage })),
      episode: 1, base_episode: 0, author: 'writer', created_at: now, scenes, coverage, committed_at: now,
      review: { actor: 'reviewer', time: now, decision: 'approve', reason: '人物对白核对。', zero_action_reason: '固定源范围无关键动作，不补造动作。' } }],
    accepted: ['c:11111111-1111-4111-8111-111111111111'],
  })
  const candidate = project.candidates[0]!
  candidate.sha256 = sha256(JSON.stringify({ episode: candidate.episode, scenes: candidate.scenes, coverage: candidate.coverage }))
  await writeFile(projectPath, JSON.stringify(project))
  const input = join(root, 'final', 'accepted.md')
  await writeFile(input, acceptedScripts(project)[0]!.script)
  return { project, projectPath, input, source }
}

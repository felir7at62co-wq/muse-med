/** Source publication refuses incomplete, foreign or redirected native evidence. */
import { mkdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { publishProductionManifest, productionManifestPath } from '../src/production-manifest.ts'
import { buildProductionPlan, productionHash } from '../src/production-plan.ts'
import type { ProductionSourceCard } from '../src/production-manifest.ts'
import { actionShot, cleanup, tempDir } from './harness.ts'

const roots: string[] = []
const failures = vi.hoisted(() => ({ inspect: '', inspectCode: 'EACCES', read: '' }))
const cancellation = vi.hoisted(() => ({ afterRead: undefined as ((path: string) => void) | undefined,
  afterMkdir: undefined as ((path: string) => void) | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    if (String(args[0]) === failures.inspect) throw Object.assign(new Error('source manifest inspection denied'), { code: failures.inspectCode })
    return await actual.lstat(...args)
  }, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const path = typeof args[0] === 'string' ? args[0] : undefined
    if (path === failures.read) throw Object.assign(new Error('source manifest read denied'), { code: 'EACCES' })
    const content = await actual.readFile(...args)
    if (path !== undefined) cancellation.afterRead?.(path)
    return content
  }, mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
    const result = await actual.mkdir(...args)
    cancellation.afterMkdir?.(String(args[0]))
    return result
  } }
})
afterEach(async () => {
  failures.inspect = ''
  failures.inspectCode = 'EACCES'
  failures.read = ''
  cancellation.afterRead = undefined
  cancellation.afterMkdir = undefined
  for (const root of roots.splice(0)) await cleanup(root)
})

async function fixture() {
  const root = await tempDir(); roots.push(root)
  const source = actionShot(1, ['时长：2秒'])
  const plan = buildProductionPlan({ project_dir: root, source_path: join(root, 'shots.txt'), source,
    source_sha256: productionHash(source), script_id: 4908, script_name: 'Source fixture', episode: 1, episode_id: 102505,
    assets: [], requirements: [], choices: [], targets: [], model: { modelId: 'model', platformId: 'channel',
      standardId: 1, modelGenerationTypeId: 2, videoStandardId: 3, genType: 3, ratio: '9:16',
      resolution: '480p', maxDurationSeconds: 30, revision: 1 } }, 8, 2)
  const card: ProductionSourceCard = { sha256: 'e'.repeat(64), card: { script_id: 4908,
    model_config: { prompt: plan.packages[0]!.prompt }, snapshot: { episodeId: 102505, episodeCount: 1,
      storyboardMaterialList: [{ materialKey: 'a1', materialUrl: 'https://cdn.test/image.png', materialType: 'image',
        materialAssetId: 12, fileName: '人物', createTime: 'audit field is excluded' }] } } }
  const receipts = { '1': { storyboard_id: 91, snapshot_sha256: card.sha256 } }
  const publish = (check = async (): Promise<string | undefined> => undefined, signal = new AbortController().signal) =>
    publishProductionManifest(plan, 'plan.json', receipts, async () => card, check, signal)
  return { root, plan, card, receipts, publish, path: productionManifestPath(plan) }
}

it('records actual prompt and stable material identities without media approval', async () => {
  const f = await fixture()
  f.card.card.model_config.prompt = String(f.card.card.model_config.prompt) + '\n已保留声音参考'
  expect(await f.publish()).toMatchObject({ status: 'published', path: f.path })
  const before = await readFile(f.path, 'utf8')
  const doc: unknown = JSON.parse(before)
  expect(doc).toMatchObject({ media_acceptance: false, video_tasks: [{ prompt: f.card.card.model_config.prompt,
    material_bindings: [{ materialKey: 'a1', materialAssetId: 12 }] }] })
  expect(before).not.toContain('"createTime"')
  expect(await f.publish()).toEqual({ status: 'unchanged', path: f.path, sha256: productionHash(before) })
  expect(await readFile(f.path, 'utf8')).toBe(before)
})

it('publishes an intentional new plan over its unchanged previous manifest', async () => {
  const f = await fixture(); await f.publish()
  const before = await readFile(f.path, 'utf8')
  f.plan.fingerprint = 'a'.repeat(64)
  f.plan.packages[0]!.prompt += '\n新方案已保存'
  f.card.card.model_config.prompt = f.plan.packages[0]!.prompt
  const current = { ...f.card, sha256: 'f'.repeat(64) }
  f.receipts['1'].snapshot_sha256 = current.sha256
  expect(await publishProductionManifest(f.plan, 'plan.json', f.receipts, async () => current,
    async () => undefined, new AbortController().signal)).toMatchObject({ status: 'published' })
  const after = await readFile(f.path, 'utf8')
  expect(after).not.toBe(before)
  expect(JSON.parse(after)).toMatchObject({ plan_fingerprint: f.plan.fingerprint,
    video_tasks: [{ prompt: f.plan.packages[0]!.prompt, snapshot_sha256: current.sha256 }] })
})

it.each(['empty', 'index', 'shots', 'shot_number'] as const)('refuses an invalid package plan: %s', async (issue) => {
  const f = await fixture()
  if (issue === 'empty') f.plan.packages = []
  if (issue === 'index') f.plan.packages[0]!.index = 2
  if (issue === 'shots') f.plan.packages[0]!.shots = []
  if (issue === 'shot_number') f.plan.packages[0]!.shots = [0]
  expect(await f.publish()).toMatchObject({ status: 'not_published', reason: 'package_plan_invalid' })
  await expect(readFile(f.path)).rejects.toThrow()
})

it('refuses absent or reused card receipts instead of inventing a missing package', async () => {
  const f = await fixture(), signal = new AbortController().signal
  expect(await publishProductionManifest(f.plan, 'plan.json', {}, async () => f.card, async () => undefined, signal))
    .toMatchObject({ status: 'not_published', reason: 'package_receipts_incomplete' })
  f.plan.packages.push({ ...f.plan.packages[0]!, index: 2, shots: [2] })
  expect(await publishProductionManifest(f.plan, 'plan.json', { ...f.receipts, '2': f.receipts['1'] },
    async () => f.card, async () => undefined, signal))
    .toMatchObject({ status: 'not_published', reason: 'package_receipts_incomplete' })
})

it.each(['script', 'episodeId', 'episodeCount', 'prompt', 'snapshot'] as const)('refuses changed native %s evidence', async (issue) => {
  const f = await fixture()
  const changed = { ...f.card, card: { ...f.card.card, model_config: { ...f.card.card.model_config },
    snapshot: { ...f.card.card.snapshot } } }
  if (issue === 'script') changed.card.script_id = 1
  if (issue === 'episodeId') changed.card.snapshot.episodeId = 9
  if (issue === 'episodeCount') changed.card.snapshot.episodeCount = 9
  if (issue === 'prompt') delete changed.card.model_config.prompt
  if (issue === 'snapshot') changed.sha256 = 'f'.repeat(64)
  expect(await publishProductionManifest(f.plan, 'plan.json', f.receipts, async () => changed,
    async () => undefined, new AbortController().signal)).toMatchObject({ status: 'not_published', reason:
    issue === 'prompt' ? 'card_prompt_unavailable' : issue === 'snapshot' ? 'current_card_changed' : 'card_project_changed' })
})

it('keeps the previous manifest when an input changes immediately before publication', async () => {
  const f = await fixture(); await f.publish()
  const before = await readFile(f.path, 'utf8')
  expect(await f.publish(async () => 'source_changed')).toMatchObject({ status: 'not_published', reason: 'source_changed' })
  expect(await readFile(f.path, 'utf8')).toBe(before)
})

it('does not publish after cancellation', async () => {
  const f = await fixture(), stop = new AbortController()
  stop.abort(new Error('stopped'))
  await expect(f.publish(undefined, stop.signal)).rejects.toThrow('stopped')
  await expect(readFile(f.path)).rejects.toThrow()
})

it('refuses a non-directory parent and retains the original file', async () => {
  const f = await fixture(), parent = join(f.root, 'episode_packages')
  await writeFile(parent, 'kept')
  await expect(f.publish()).rejects.toThrow('不允许')
  expect(await readFile(parent, 'utf8')).toBe('kept')
})

it('does not treat an inaccessible package parent as an absent manifest', async () => {
  const f = await fixture(), occupied = join(f.root, 'occupied-project')
  await writeFile(occupied, 'kept')
  f.plan.project_dir = occupied
  await expect(f.publish()).rejects.toThrow('不允许')
  expect(await readFile(occupied, 'utf8')).toBe('kept')
})

it('does not approve or replace the previous manifest when inspecting its target is denied', async () => {
  const f = await fixture(); await f.publish()
  const before = await readFile(f.path, 'utf8'), check = vi.fn(async () => undefined)
  failures.inspect = await realpath(f.path)
  await expect(f.publish(check)).rejects.toMatchObject({ code: 'EACCES', message: 'source manifest inspection denied' })
  expect(check).not.toHaveBeenCalled()
  expect(await readFile(f.path, 'utf8')).toBe(before)
})

it('fails if the resolved project root disappears before its first directory check', async () => {
  const f = await fixture(); await f.publish()
  const before = await readFile(f.path, 'utf8'), check = vi.fn(async () => undefined)
  failures.inspect = await realpath(f.root)
  failures.inspectCode = 'ENOENT'
  await expect(f.publish(check)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(check).not.toHaveBeenCalled()
  expect(await readFile(f.path, 'utf8')).toBe(before)
})

it('preserves a target replaced by a directory during the last input check', async () => {
  const f = await fixture(), retained = join(f.path, 'external-state.txt')
  await mkdir(join(f.root, 'episode_packages', '01'), { recursive: true })
  await expect(f.publish(async () => {
    await mkdir(f.path)
    await writeFile(retained, 'kept')
    return undefined
  })).rejects.toThrow('不允许')
  expect(await readFile(retained, 'utf8')).toBe('kept')
})

it('preserves the previous manifest when its final read is denied', async () => {
  const f = await fixture(); await f.publish()
  const before = await readFile(f.path, 'utf8')
  await expect(f.publish(async () => {
    failures.read = await realpath(f.path)
    return undefined
  })).rejects.toMatchObject({ code: 'EACCES', message: 'source manifest read denied' })
  failures.read = ''
  expect(await readFile(f.path, 'utf8')).toBe(before)
})

it.each(['readback', 'input_check', 'created'] as const)('preserves an external ordinary manifest changed during %s', async (stage) => {
  const f = await fixture(); await f.publish()
  const original = await readFile(f.path, 'utf8')
  const document: unknown = JSON.parse(original)
  if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new Error('Expected a manifest object')
  const external = JSON.stringify({ ...document, plan_path: 'externally-updated-plan.json' }, null, 2) + '\n'
  if (stage === 'created') await rename(f.path, f.path + '.previous')
  const result = await publishProductionManifest(f.plan, 'plan.json', f.receipts, async () => {
    if (stage === 'readback') await writeFile(f.path, external)
    return f.card
  }, async () => {
    if (stage !== 'readback') await writeFile(f.path, external)
    return undefined
  }, new AbortController().signal)
  expect(result).toMatchObject({ status: 'not_published', reason: 'manifest_target_changed' })
  expect(await readFile(f.path, 'utf8')).toBe(external)
})

it('does not report unchanged when cancelled while reading the previous manifest', async () => {
  const f = await fixture(); await f.publish()
  const before = await readFile(f.path, 'utf8'), stop = new AbortController()
  const target = await realpath(f.path)
  await expect(f.publish(async () => {
    cancellation.afterRead = (path) => { if (path === target) stop.abort(new Error('cancelled during final read')) }
    return undefined
  }, stop.signal)).rejects.toThrow('cancelled during final read')
  expect(await readFile(f.path, 'utf8')).toBe(before)
})

it('does not commit when cancelled while creating the output directory', async () => {
  const f = await fixture(), stop = new AbortController(), directory = join(await realpath(f.root), 'episode_packages', '01')
  cancellation.afterMkdir = (path) => { if (path === directory) stop.abort(new Error('cancelled before commit')) }
  await expect(f.publish(undefined, stop.signal)).rejects.toThrow('cancelled before commit')
  await expect(readFile(f.path)).rejects.toThrow()
})

it.each(['project', 'packages', 'episode', 'removed_episode'] as const)('refuses a %s directory archived during the final input check', async (change) => {
  const f = await fixture(); await f.publish()
  const before = await readFile(f.path, 'utf8')
  const path = change === 'project' ? f.root : change === 'packages' ? join(f.root, 'episode_packages')
    : join(f.root, 'episode_packages', '01')
  const archived = path + '-archived'
  if (change === 'project') roots.push(archived)
  expect(await f.publish(async () => {
    await rename(path, archived)
    if (change !== 'removed_episode') await mkdir(path)
    return undefined
  })).toMatchObject({ status: 'not_published', reason: 'manifest_target_changed' })
  const oldManifest = change === 'project' ? join(archived, 'episode_packages', '01', 'package.json')
    : change === 'packages' ? join(archived, '01', 'package.json') : join(archived, 'package.json')
  expect(await readFile(oldManifest, 'utf8')).toBe(before)
  await expect(readFile(f.path)).rejects.toThrow()
})

it('refuses a parent replaced by a directory link during the final input check', async () => {
  const f = await fixture(), outside = await tempDir(); roots.push(outside)
  await f.publish()
  const before = await readFile(f.path, 'utf8'), parent = join(f.root, 'episode_packages'), archived = parent + '-archived'
  await expect(f.publish(async () => {
    await rename(parent, archived)
    await symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')
    return undefined
  })).rejects.toThrow('不允许')
  expect(await readFile(join(archived, '01', 'package.json'), 'utf8')).toBe(before)
  await expect(readFile(join(outside, '01', 'package.json'))).rejects.toThrow()
})

it('refuses a project alias redirected during the final input check', async () => {
  const f = await fixture(), other = await tempDir(); roots.push(other)
  const alias = join(f.root, 'project-link')
  await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  f.plan.project_dir = alias
  await f.publish()
  const before = await readFile(f.path, 'utf8')
  expect(await f.publish(async () => {
    await rename(alias, alias + '-archived')
    await symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir')
    return undefined
  })).toMatchObject({ status: 'not_published', reason: 'manifest_target_changed' })
  expect(await readFile(f.path, 'utf8')).toBe(before)
  await expect(readFile(join(other, 'episode_packages', '01', 'package.json'))).rejects.toThrow()
})

it.skipIf(process.platform === 'win32')('refuses an output symlink without touching its target', async () => {
  const f = await fixture(), other = join(f.root, 'other.json')
  await writeFile(other, 'kept')
  await mkdir(join(f.root, 'episode_packages', '01'), { recursive: true })
  await symlink(other, f.path)
  await expect(f.publish()).rejects.toThrow('不允许')
  expect(await readFile(other, 'utf8')).toBe('kept')
})

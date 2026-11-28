import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ShotScript from '@deepseek-ai/dsh-tool-shot-script'
import Tools from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveContentListeningVoices } from '../src/content-listening-voices.ts'

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const byShot = ['寻到了。', '', '请等一下。', '谁见过？', '我见过。', '', '去看看。', '', '留步。', '听我说。', '回去吧。']
const names = ['甲', '', '甲', '乙', '甲', '', '甲', '', '乙', '铜蛤蟆', '铜蛤蟆']
const groups = [ [1, 2, 3, 4, 5], [6, 7, 8], [9, 10, 11] ]

function testWav(id: number) {
  const wav = Buffer.alloc(44 + 16_000)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16_000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(16_000, 40)
  wav.writeInt16LE(id, 44)
  return wav
}

const temporary: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => { await context.fiber.dispose() }))
  await Promise.all(temporary.splice(0).map(async (project) => {
    await rm(project, { recursive: true, force: true })
  }))
})

async function fixture(options: {
  direct?: boolean
  packages?: { index?: number; shots: number[] }[]
  authored?: { shot: number; lines: string[] }[]
  render?: number[]
  propAliases?: string[]
  sameAlias?: boolean
  noRegisteredAdult?: boolean
  noRegistry?: boolean
  propLine?: string
} = {}) {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'muse-voice-layout-')))
  temporary.push(project)
  const context = new Context()
  contexts.push(context)
  await context.plugin(SystemPrompt)
  await context.plugin(Tools)
  await context.plugin(ShotScript)
  const parseVoiceScript = context.get('shotScriptVoice')
  if (parseVoiceScript === undefined) throw new Error('Shot-script plugin did not provide the Host parser')
  const episode = '21'
  const script = byShot.map((line, i) => {
    const header = `【镜头${String(i + 1)}】\n画面：房间。\n`
    if (line === '') return `${header}发声类型：action`
    if (i === 9 && !options.direct) return `${header}发声类型：心声\n${options.propLine ?? `台词：铜蛤蟆：${line}`}`
    return `${header}主体状态追踪：\n台词：${names[i]}：${line}\n发声类型：${i >= 9 ? 'vo' : 'dialogue'}`
  }).join('\n\n')
  const videoTasks = options.packages ?? groups.map((shots, i) => ({ index: i + 1, shots }))
  const production = JSON.stringify({ kind: 'muse_production', version: 1, episode,
    script_id: 6613, source_sha256: digest(script), video_tasks: videoTasks })
  const directory = join(project, 'episode_packages', episode)
  await mkdir(directory, { recursive: true })
  const scriptPath = join(project, 'script.md'), configPath = join(project, 'project_config.json')
  const productionPath = join(directory, `production-${digest(production)}.json`)
  const authoredPath = join(project, 'authored.json')
  const indexed = (shots: number[][]) => shots.map((ids, i) => ({ shot: i + 1,
    lines: ids.flatMap(id => byShot[id - 1] ? [byShot[id - 1]!] : []) }))
  const authored = options.authored ?? indexed(options.direct ? byShot.map((_line, i) => [i + 1]) : groups)
  const authoredJson = JSON.stringify({ schema_version: 1, shots: authored })
  const roles = [
    { character_id: 'a', name: '甲', aliases: options.sameAlias ? ['铜蛤蟆'] : undefined, voice_period_id: 'adult' },
    { character_id: 'b', name: '乙', voice_period_id: 'adult' },
    { character_id: 'prop', name: '配音铜蟾', aliases: options.propAliases ?? ['铜蛤蟆'], voice_period_id: 'object' },
  ]
  const references = []
  const characters = []
  for (const [index, role] of roles.entries()) {
    const wav = testWav(index + 1), asset_id = index + 10
    const path = join(project, `${role.character_id}.wav`)
    await writeFile(path, wav)
    const profile = options.noRegisteredAdult && role.character_id === 'b' ? {} : {
      reference_audio: `https://example.invalid/${role.character_id}.wav`, reference_audio_asset_id: asset_id,
      reference_audio_sha256: digest(wav), reference_audio_duration_seconds: 1,
    }
    characters.push({ ...role, voice_profiles: [{ voice_period_id: role.voice_period_id, ...profile }] })
    references.push({ character_id: role.character_id, voice_period_id: role.voice_period_id, asset_id, path })
  }
  const config = JSON.stringify({ jubian_script_id: 6613, project_bible: options.noRegistry ? {} : { characters } })
  await Promise.all([writeFile(scriptPath, script), writeFile(configPath, config), writeFile(productionPath, production),
    writeFile(authoredPath, authoredJson)])
  const input = { project, episode, authored, authoredPath, authoredSha256: digest(authoredJson), parseVoiceScript,
    renderedShots: options.render ?? (options.direct ? byShot : groups).map((_unused, i) => i + 1),
    context: { source_script: scriptPath, references },
    renderedInputs: [{ path: configPath, sha256: digest(config) }, { path: productionPath, sha256: digest(production) },
      { path: authoredPath, sha256: digest(authoredJson) }], read: async (path: string) => await readFile(path) }
  return { input, scriptPath, script }
}

describe('formal voice review per-shot and grouped authorship', () => {
  it('will not read a manifest recorded under a different project', async () => {
    const { input } = await fixture()
    const projectAlias = await realpath(await mkdtemp(join(tmpdir(), 'muse-unrelated-voice-')))
    temporary.push(projectAlias)
    const renderedInputs = input.renderedInputs.map(file => file.path.includes('production-')
      ? { ...file, path: join(projectAlias, relative(input.project, file.path)) } : file)
    const read = async () => { throw new Error('unexpected content read') }
    await expect(resolveContentListeningVoices({ ...input, projectAlias, renderedInputs, read }))
      .rejects.toThrow('当前集唯一的正式制作分包清单')
  })

  it('maps every original shot and all eight lines to their authoritative rendered groups', async () => {
    const { input } = await fixture()
    const result = await resolveContentListeningVoices(input)
    expect(result.evidence.clip_mapping).toEqual(groups.map((source_shots, i) => ({ render_shot: i + 1, source_shots })))
    expect(result.spoken.map(({ shot, render_shot, line_index, character_id }) => [shot, render_shot, line_index, character_id]))
      .toEqual([[1, 1, 1, 'a'], [3, 1, 2, 'a'], [4, 1, 3, 'b'], [5, 1, 4, 'a'],
        [7, 2, 1, 'a'], [9, 3, 1, 'b'], [10, 3, 2, 'prop'], [11, 3, 3, 'prop']])
    expect(result.spoken[6]).toMatchObject({ voice_type: 'vo', reference_attachment: 4 })
    expect(result.evidence.references).toHaveLength(3)
  })

  it('preserves individually rendered shots without package-mode fields', async () => {
    const { input } = await fixture({ direct: true, packages: groups.map(shots => ({ shots })) })
    const result = await resolveContentListeningVoices(input)
    expect(result.evidence.clip_mapping).toBeUndefined()
    expect(result.spoken[6]).toEqual({ shot: 10, voice_type: 'vo', character_id: 'prop', reference_attachment: 4 })
  })

  it.each([true, false])('matches by actual shot for JSON declarations in a different order (direct %s)', async (direct) => {
    const canonical = await fixture({ direct })
    const { input } = await fixture({ direct, authored: [...canonical.input.authored].reverse() })
    const expected = await resolveContentListeningVoices(canonical.input)
    const result = await resolveContentListeningVoices(input)
    expect(result.spoken).toEqual(expected.spoken)
    expect(result.evidence.clip_mapping).toEqual(expected.evidence.clip_mapping)
  })

  it.each([
    ['reordered originals', [{ index: 1, shots: [1, 3, 2, 4, 5] }, { index: 2, shots: groups[1]! }, { index: 3, shots: groups[2]! }], '完整覆盖'],
    ['missing originals', [{ index: 1, shots: groups[0]! }, { index: 2, shots: groups[1]! }, { index: 3, shots: [9, 11] }], '完整覆盖'],
    ['duplicate originals', [{ index: 1, shots: groups[0]! }, { index: 2, shots: groups[1]! }, { index: 3, shots: [9, 10, 10] }], '完整覆盖'],
    ['wrong group index', [{ index: 2, shots: groups[0]! }, { index: 3, shots: groups[1]! }, { index: 4, shots: groups[2]! }], '原分镜顺序'],
    ['missing group index', groups.map(shots => ({ shots })), '成片分包编号'],
    ['a spoken line moved between groups', [{ index: 1, shots: [1, 2, 3, 4] }, { index: 2, shots: [5, 6, 7, 8] },
      { index: 3, shots: groups[2]! }], '实际对白'],
  ] as const)('rejects %s', async (_label, packages, reason) => {
    const { input } = await fixture({ packages: packages.map(row => ({ ...row, shots: [...row.shots] })) })
    await expect(resolveContentListeningVoices(input)).rejects.toThrow(reason)
  })

  it.each([
    ['reordered render and authored groups', [3, 1, 2], '成片分包编号'],
    ['wrong render identifiers', [1, 2, 4], '成片分包编号'],
  ] as const)('rejects %s', async (_label, order, reason) => {
    const { input } = await fixture({ render: [...order] })
    const authored = input.authored.map((row, i) => ({ ...row, shot: order[i]! }))
    await expect(resolveContentListeningVoices({ ...input, authored })).rejects.toThrow(reason)
  })

  it.each([
    ['missing alias', { propAliases: [] }, '唯一对应'],
    ['ambiguous alias', { sameAlias: true }, '唯一对应'],
    ['no enrolled voice registry', { noRegistry: true }, '缺少本集角色及声线登记'],
    ['no approved voice asset', { noRegisteredAdult: true }, '已登记的批准 WAV'],
    ['unqualified narrator prefix', { propLine: '旁白：铜蛤蟆：听我说。' }, '实际对白'],
    ['legacy voice with an absent speaker', { propLine: '台词：听我说。' }, '唯一对应'],
  ] as const)('cannot use layout proof to bypass %s', async (_label, options, reason) => {
    const { propAliases, ...rest } = options as typeof options & { readonly propAliases?: readonly string[] }
    const { input } = await fixture({ ...rest, ...(propAliases === undefined ? {} : { propAliases: [...propAliases] }) })
    await expect(resolveContentListeningVoices(input)).rejects.toThrow(reason)
  })

  it('refuses conflicting explicitly authored speakers identified by the native parser', async () => {
    const { input, script } = await fixture({ propLine: '主体状态追踪：\n说话人：甲\n台词：乙：听我说。' })
    expect(input.parseVoiceScript(script).issues.find(issue => issue.code === 'speaker_mismatch')?.severity).toBe('failure')
    await expect(resolveContentListeningVoices(input)).rejects.toThrow('完整、可识别的逐镜说话人和对白')
  })

  it('rejects script bytes changed after the original render', async () => {
    const { input, script, scriptPath } = await fixture()
    await writeFile(scriptPath, script.replace('寻到了。', '没有。'))
    await expect(resolveContentListeningVoices(input)).rejects.toThrow('本次正式制作分包不符')
  })
})

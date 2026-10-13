import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Assets from '../src/index.ts'
import { recommendCharacterReference } from '../src/reference.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'muse-character-reference-'))
  const specs = [
    { id: 'char_3d_0002', style: 'urban', tags: ['西装', '领带'] },
    { id: 'char_3d_0003', style: 'unknown', tags: ['甜妹', '少女感'] },
    { id: 'char_3d_0004', style: 'ancient', tags: ['古风发饰', '长袍'] },
    { id: 'char_3d_0005', style: 'urban', tags: ['西装'] },
  ] as const
  const objects = []
  for (const spec of specs) {
    const folder = join(root, spec.style === 'unknown' ? 'pending_review' : spec.style, spec.id)
    await mkdir(folder, { recursive: true })
    const image = Buffer.from(`synthetic-image-${spec.id}`)
    const sha256 = createHash('sha256').update(image).digest('hex')
    await writeFile(join(folder, 'face.jpg'), image)
    const dir = `${spec.style === 'unknown' ? 'pending_review' : spec.style}/${spec.id}`
    objects.push({ reference_id: spec.id, scope: 'public_reference', status: 'pending_review',
      media: 'image', metadata_relative_path: `${dir}/metadata.json`, image_relative_path: `${dir}/face.jpg`,
      sha256, bytes: image.length, rights_status: 'unconfirmed', reuse_approved: false,
      usage_policy: { direct_use: false, agent_selection_required: true, auto_bind: false },
      search: { style: spec.style, genre: [], tags: spec.tags,
        appearance: { descriptors: spec.tags.map(value => ({ value,
          source: { kind: 'prior_local_visual_review', record: 'fixture' } })),
        style_candidates: [{ value: spec.style === 'unknown' ? 'urban' : spec.style,
          source: { kind: 'owner_feedback', record: 'fixture' } }] },
        role_fit: { suitable_eras: [], avoid_eras: [], unconfirmed_eras: [], role_traits: [] } } })
    const item = objects.at(-1)
    if (!item) throw new Error('Missing synthetic reference entry')
    await writeFile(join(folder, 'metadata.json'), JSON.stringify({ schema_version: 2, id: spec.id,
      scope: 'public_reference', status: 'pending_review', asset_role: 'reference', usage_policy: item.usage_policy,
      style: item.search.style, genre: item.search.genre, tags: item.search.tags,
      appearance: item.search.appearance, role_fit: item.search.role_fit,
      images: [{ filename: 'face.jpg', sha256, bytes: image.length }] }))
  }
  const indexPath = join(root, 'character_reference_index.draft.json')
  await writeFile(indexPath, JSON.stringify({ schema_version: 1, index_type: 'character_reference',
    lifecycle: 'draft', publishable: false, total: objects.length, objects }))
  return { root, indexPath }
}

async function files(root: string): Promise<string[]> {
  const result: string[] = []
  async function visit(dir: string) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name)
      if (item.isDirectory()) await visit(path)
      else result.push(`${path}:${createHash('sha256').update(await readFile(path)).digest('hex')}`)
    }
  }
  await visit(root)
  return result.sort()
}

it('recommends one evidence-backed reference, allows pending review, and abstains on era or ties', async () => {
  const { root, indexPath } = await fixture()
  try {
    const recommended = await recommendCharacterReference(indexPath,
      { role_description: '现代都市角色，穿西装打领带', style: 'urban', desired_tags: ['领带'] })
    expect(recommended).toMatchObject({ status: 'recommended', read_only: true,
      apply_allowed: false, local_writes: 0, remote_writes: 0, paid_requests: 0,
      recommendation: { reference_id: 'char_3d_0002', status: 'pending_review' } })
    expect(recommended.uncertainty.join(' ')).toContain('复用权利尚未确认')
    expect(recommended.evidence).toContainEqual({ label: '领带',
      source_kind: 'prior_local_visual_review', source_record: 'fixture' })
    expect((await recommendCharacterReference(indexPath,
      { role_description: '甜妹少女感', style: 'urban', desired_tags: ['甜妹'] })).recommendation?.reference_id)
      .toBe('char_3d_0003')
    expect((await recommendCharacterReference(indexPath,
      { role_description: '1980 年代甜妹', desired_tags: ['甜妹'], era: '1980年代' })).status).toBe('no_match')
    expect((await recommendCharacterReference(indexPath,
      { role_description: '现代都市西装人物', style: 'urban', desired_tags: ['西装'] })).status).toBe('needs_review')
    expect((await recommendCharacterReference(indexPath,
      { role_description: '宇航员', desired_tags: ['宇航服'] })).status).toBe('no_match')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects an altered image and unsafe index paths before returning a recommendation', async () => {
  const { root, indexPath } = await fixture()
  try {
    await writeFile(join(root, 'urban', 'char_3d_0002', 'face.jpg'), 'altered')
    await expect(recommendCharacterReference(indexPath,
      { role_description: '西装角色', desired_tags: ['西装'] })).rejects.toThrow('image differs')
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
      objects: { image_relative_path: string }[]
    }
    if (!index.objects[0]) throw new Error('Missing test entry')
    index.objects[0].image_relative_path = '../outside.jpg'
    await writeFile(indexPath, JSON.stringify(index))
    await expect(recommendCharacterReference(indexPath,
      { role_description: '西装角色', desired_tags: ['西装'] })).rejects.toThrow('unsafe relative path')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('registers only in an opted-in real Loader composition without network or file writes', async () => {
  const { root, indexPath } = await fixture()
  const profile = join(root, 'cordis.yml')
  await writeFile(profile, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-character-reference'",
    '  config:',
    `    referenceIndexPath: '${indexPath.replaceAll('\\', '/')}'`,
    '',
  ].join('\n'))
  const before = await files(root)
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('unexpected network') })
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
      ['@deepseek-ai/dsh-tool-character-reference', Assets],
    ])
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected loader hooks') },
      getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
      resolveSync() { throw new Error('Unexpected loader resolution') },
      load() { throw new Error('Unexpected loader load') }, async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
        return modules.get(specifier)
      } }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect(ctx.tools.get('drama_assets')).toBeUndefined()
    expect(ctx.tools.get('drama_cloud_assets')).toBeUndefined()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['drama_character_references'])
    const definition = ctx.tools.get('drama_character_references')
    if (!definition) throw new Error('Missing QA-only character reference tool')
    expect(Object.keys(definition.parameters.properties ?? {})).toEqual(['role_description', 'style', 'desired_tags', 'era'])
    const args = { role_description: '现代都市角色，穿西装打领带', style: 'urban', desired_tags: ['领带'] }
    expect(validateJsonSchemaValue(definition.parameters, args, '')).toEqual([])
    const result = await ctx.tools.execute({ callId: ToolCallId('local-reference-loader'),
      name: 'drama_character_references', arguments: args, signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    expect(validateJsonSchemaValue(definition.output.schema, result.value, '')).toEqual([])
    expect(result.value).toMatchObject({ status: 'recommended',
      recommendation: { reference_id: 'char_3d_0002' }, local_writes: 0, remote_writes: 0 })
    expect(network).not.toHaveBeenCalled()
    expect(await files(root)).toEqual(before)
    const tools = ctx.tools
    await ctx.fiber.dispose()
    expect(tools.get('drama_character_references')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    network.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

if (process.env.MUSE_REFERENCE_QA_PROFILE) {
  it('reads the configured local draft through the isolated QA Loader profile', async () => {
    const profile = process.env.MUSE_REFERENCE_QA_PROFILE
    if (!profile) throw new Error('Missing QA profile path')
    const text = await readFile(profile, 'utf8')
    const indexPath = text.match(/referenceIndexPath: '([^']+)'/)?.[1]
    if (!indexPath) throw new Error('QA profile has no fixed local draft path')
    const root = dirname(indexPath)
    const before = await files(root)
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('unexpected network') })
    const ctx = new Context()
    try {
      ctx.baseUrl = pathToFileURL(dirname(profile)).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      const modules = new Map<string, unknown>([
        ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
        ['@deepseek-ai/dsh-tool-character-reference', Assets],
      ])
      ctx.loader.internal = { version: 'v2', loadCache: new Map(),
        register() { throw new Error('Unexpected loader hooks') },
        getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
        resolveSync() { throw new Error('Unexpected loader resolution') },
        load() { throw new Error('Unexpected loader load') }, async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
          return modules.get(specifier)
        } }
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
      await ctx.loader.await()
      for (const entry of ctx.loader.entries()) await entry.fiber?.await()
      expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['drama_character_references'])
      const result = await ctx.tools.execute({ callId: ToolCallId('reference-qa-profile'),
        name: 'drama_character_references', arguments: { role_description: '现代甜美少女感角色，带蝴蝶结',
          style: 'urban', desired_tags: ['甜妹', '蝴蝶结'] }, signal: new AbortController().signal })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      expect(result.value).toMatchObject({ status: 'recommended',
        recommendation: { reference_id: 'char_3d_0003', status: 'pending_review' },
        read_only: true, apply_allowed: false, local_writes: 0, remote_writes: 0, paid_requests: 0 })
      expect(network).not.toHaveBeenCalled()
      expect(await files(root)).toEqual(before)
    } finally {
      await ctx.fiber.dispose()
      network.mockRestore()
    }
  })
}

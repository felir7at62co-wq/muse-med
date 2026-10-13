import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
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

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return value as Record<string, unknown>
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected array')
  return value
}

async function readIndex(indexPath: string): Promise<Record<string, unknown>> {
  return asRecord(JSON.parse(await readFile(indexPath, 'utf8')))
}

async function writeIndex(indexPath: string, index: Record<string, unknown>): Promise<void> {
  await writeFile(indexPath, JSON.stringify(index))
}

function firstEntry(index: Record<string, unknown>): Record<string, unknown> {
  return asRecord(asArray(index.objects)[0])
}

async function expectInvalidIndex(
  mutate: (index: Record<string, unknown>) => void,
  message: string | RegExp,
  label?: string,
): Promise<void> {
  const { root, indexPath } = await fixture()
  try {
    const index = await readIndex(indexPath)
    mutate(index)
    await writeIndex(indexPath, index)
    await expect(recommendCharacterReference(indexPath,
      { role_description: '西装角色', desired_tags: ['西装'] }), label).rejects.toThrow(message)
  } finally { await rm(root, { recursive: true, force: true }) }
}

async function expectInvalidMetadata(
  mutate: (metadata: Record<string, unknown>) => void,
  message: string | RegExp = 'does not match its v2 metadata',
  label?: string,
): Promise<void> {
  const { root, indexPath } = await fixture()
  try {
    const index = await readIndex(indexPath)
    const entry = firstEntry(index)
    const metadataPath = join(root, String(entry.metadata_relative_path))
    const metadata = asRecord(JSON.parse(await readFile(metadataPath, 'utf8')))
    mutate(metadata)
    await writeFile(metadataPath, JSON.stringify(metadata))
    await expect(recommendCharacterReference(indexPath,
      { role_description: '西装角色', desired_tags: ['西装'] }), label).rejects.toThrow(message)
  } finally { await rm(root, { recursive: true, force: true }) }
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

it('rejects empty and relative plugin configuration before registering a tool', async () => {
  const empty = new Context()
  const relative = new Context()
  try {
    expect(() => Assets.apply(empty, { referenceIndexPath: '' })).toThrow('absolute local referenceIndexPath')
    expect(() => Assets.apply(relative, { referenceIndexPath: 'relative/index.json' }))
      .toThrow('absolute local referenceIndexPath')
  } finally {
    await empty.fiber.dispose()
    await relative.fiber.dispose()
  }
})

it('rejects malformed requests before reading the configured draft', async () => {
  const missing = join(tmpdir(), 'does-not-exist-character-reference.json')
  await expect(recommendCharacterReference(missing, { role_description: '   ' }))
    .rejects.toThrow('bounded role description')
  await expect(recommendCharacterReference(missing, { role_description: '角'.repeat(2001) }))
    .rejects.toThrow('bounded role description')
  await expect(recommendCharacterReference(missing,
    { role_description: '角色', desired_tags: '标签' as unknown as string[] }))
    .rejects.toThrow('bounded role description')
  await expect(recommendCharacterReference(missing,
    { role_description: '角色', desired_tags: Array.from({ length: 21 }, (_, index) => `标签${index}`) }))
    .rejects.toThrow('bounded role description')
})

it('rejects a relative index, invalid JSON, and each invalid draft header', async () => {
  await expect(recommendCharacterReference('relative-index.json', { role_description: '角色' }))
    .rejects.toThrow('referenceIndexPath must be absolute')
  const invalidJson = await mkdtemp(join(tmpdir(), 'muse-character-reference-json-'))
  try {
    const indexPath = join(invalidJson, 'index.json')
    await writeFile(indexPath, '{')
    await expect(recommendCharacterReference(indexPath, { role_description: '角色' })).rejects.toThrow()
  } finally { await rm(invalidJson, { recursive: true, force: true }) }
  const headerMutations: [string, (index: Record<string, unknown>) => void][] = [
    ['schema', (index) => { index.schema_version = 2 }],
    ['type', (index) => { index.index_type = 'asset' }],
    ['lifecycle', (index) => { index.lifecycle = 'published' }],
    ['publishable', (index) => { index.publishable = true }],
    ['objects', (index) => { index.objects = null }],
    ['total', (index) => { index.total = 99 }],
  ]
  for (const [name, mutate] of headerMutations) {
    await expectInvalidIndex(mutate, /complete local draft/, name)
  }
})

it('rejects missing, malformed, unsafe, and duplicate entry fields', async () => {
  const entryMutations: [string, (entry: Record<string, unknown>) => void][] = [
    ['null entry', (entry) => { Object.keys(entry).forEach(key => Reflect.deleteProperty(entry, key)) }],
    ['usage policy', (entry) => { delete entry.usage_policy }],
    ['search', (entry) => { delete entry.search }],
    ['appearance', (entry) => { delete asRecord(entry.search).appearance }],
    ['role fit', (entry) => { delete asRecord(entry.search).role_fit }],
    ['descriptors array', (entry) => { asRecord(asRecord(entry.search).appearance).descriptors = null }],
    ['style candidates array', (entry) => { asRecord(asRecord(entry.search).appearance).style_candidates = null }],
    ['reference id', (entry) => { delete entry.reference_id }],
    ['scope', (entry) => { delete entry.scope }],
    ['status', (entry) => { delete entry.status }],
    ['media', (entry) => { delete entry.media }],
    ['metadata path', (entry) => { delete entry.metadata_relative_path }],
    ['image path', (entry) => { delete entry.image_relative_path }],
    ['sha', (entry) => { delete entry.sha256 }],
    ['bytes', (entry) => { delete entry.bytes }],
    ['rights', (entry) => { delete entry.rights_status }],
    ['reuse', (entry) => { delete entry.reuse_approved }],
    ['direct use', (entry) => { asRecord(entry.usage_policy).direct_use = true }],
    ['auto bind', (entry) => { asRecord(entry.usage_policy).auto_bind = true }],
    ['agent selection', (entry) => { asRecord(entry.usage_policy).agent_selection_required = false }],
    ['style', (entry) => { delete asRecord(entry.search).style }],
    ['tags array', (entry) => { asRecord(entry.search).tags = null }],
    ['genre array', (entry) => { asRecord(entry.search).genre = null }],
    ['tag value', (entry) => { asRecord(entry.search).tags = [1] }],
    ['genre value', (entry) => { asRecord(entry.search).genre = [1] }],
    ['unbacked tag', (entry) => { asRecord(entry.search).tags = ['不存在'] }],
    ['unbacked style', (entry) => { asRecord(entry.search).style = 'fantasy' }],
    ['suitable eras', (entry) => { asRecord(asRecord(entry.search).role_fit).suitable_eras = null }],
    ['avoid eras', (entry) => { asRecord(asRecord(entry.search).role_fit).avoid_eras = null }],
    ['unconfirmed eras', (entry) => { asRecord(asRecord(entry.search).role_fit).unconfirmed_eras = null }],
  ]
  for (const [name, mutate] of entryMutations) {
    await expectInvalidIndex(index => mutate(firstEntry(index)), /invalid or duplicate entry/, name)
  }
  const sourcedMutations: [string, (value: Record<string, unknown>) => void][] = [
    ['null descriptor', (value) => { asRecord(asRecord(value.search).appearance).descriptors = [null] }],
    ['missing descriptor value', (value) => {
      const descriptor = asRecord(asArray(asRecord(asRecord(value.search).appearance).descriptors)[0])
      delete descriptor.value
    }],
    ['missing source kind', (value) => {
      const descriptor = asRecord(asArray(asRecord(asRecord(value.search).appearance).descriptors)[0])
      delete asRecord(descriptor.source).kind
    }],
    ['missing source record', (value) => {
      const descriptor = asRecord(asArray(asRecord(asRecord(value.search).appearance).descriptors)[0])
      delete asRecord(descriptor.source).record
    }],
  ]
  for (const [name, mutate] of sourcedMutations) {
    await expectInvalidIndex(index => mutate(firstEntry(index)), /invalid or duplicate entry/, name)
  }
  await expectInvalidIndex((index) => {
    const objects = asArray(index.objects)
    asRecord(objects[1]).reference_id = firstEntry(index).reference_id
  }, /invalid or duplicate entry/)
  await expectInvalidIndex((index) => { firstEntry(index).reference_id = 'bad-id' }, /invalid or duplicate entry/)
  await expectInvalidIndex((index) => { firstEntry(index).scope = 'project' }, /invalid or duplicate entry/)
  await expectInvalidIndex((index) => { firstEntry(index).media = 'video' }, /invalid or duplicate entry/)
})

it('rejects every metadata/index mismatch and both image integrity failures', async () => {
  const metadataMutations: [string, (metadata: Record<string, unknown>) => void][] = [
    ['id', (metadata) => { metadata.id = 'char_3d_9999' }],
    ['schema', (metadata) => { metadata.schema_version = 1 }],
    ['role', (metadata) => { metadata.asset_role = 'asset' }],
    ['scope', (metadata) => { metadata.scope = 'project' }],
    ['status', (metadata) => { metadata.status = 'approved' }],
    ['policy', (metadata) => { asRecord(metadata.usage_policy).auto_bind = true }],
    ['style', (metadata) => { metadata.style = 'ancient' }],
    ['genre', (metadata) => { metadata.genre = ['other'] }],
    ['tags', (metadata) => { metadata.tags = ['other'] }],
    ['appearance', (metadata) => { metadata.appearance = {} }],
    ['role fit', (metadata) => { metadata.role_fit = {} }],
    ['images', (metadata) => { delete metadata.images }],
    ['image filename', (metadata) => { asRecord(asArray(metadata.images)[0]).filename = 'other.jpg' }],
    ['image sha', (metadata) => { asRecord(asArray(metadata.images)[0]).sha256 = '0'.repeat(64) }],
    ['image bytes', (metadata) => { asRecord(asArray(metadata.images)[0]).bytes = 0 }],
  ]
  for (const [name, mutate] of metadataMutations) await expectInvalidMetadata(mutate, undefined, name)

  const sizeFixture = await fixture()
  try {
    await writeFile(join(sizeFixture.root, 'urban', 'char_3d_0002', 'face.jpg'), 'x')
    await expect(recommendCharacterReference(sizeFixture.indexPath,
      { role_description: '西装角色', desired_tags: ['西装'] })).rejects.toThrow('image differs')
  } finally { await rm(sizeFixture.root, { recursive: true, force: true }) }

  const hashFixture = await fixture()
  try {
    const imagePath = join(hashFixture.root, 'urban', 'char_3d_0002', 'face.jpg')
    const original = await readFile(imagePath)
    await writeFile(imagePath, Buffer.alloc(original.length, 1))
    await expect(recommendCharacterReference(hashFixture.indexPath,
      { role_description: '西装角色', desired_tags: ['西装'] })).rejects.toThrow('image differs')
  } finally { await rm(hashFixture.root, { recursive: true, force: true }) }
})

it('rejects missing files, mismatched character directories, and junction escapes', async () => {
  await expectInvalidIndex((index) => { firstEntry(index).image_relative_path = 'missing.jpg' }, /ENOENT|cannot find/i)
  await expectInvalidIndex((index) => {
    firstEntry(index).image_relative_path = 'urban/char_3d_0005/face.jpg'
  }, /must share their character directory/)
  await expectInvalidIndex((index) => {
    const entry = firstEntry(index)
    entry.metadata_relative_path = 'urban/char_3d_0005/metadata.json'
    entry.image_relative_path = 'urban/char_3d_0005/face.jpg'
  }, /must share their character directory/)

  const { root, indexPath } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'muse-character-reference-outside-'))
  try {
    const linked = join(root, 'linked-outside')
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(outside, 'face.jpg'), 'outside')
    const index = await readIndex(indexPath)
    firstEntry(index).image_relative_path = 'linked-outside/face.jpg'
    await writeIndex(indexPath, index)
    await expect(recommendCharacterReference(indexPath,
      { role_description: '西装角色', desired_tags: ['西装'] })).rejects.toThrow('escapes the configured draft root')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

it('covers style, description, era, approval, rights, and uncertainty recommendation branches', async () => {
  const { root, indexPath } = await fixture()
  try {
    expect((await recommendCharacterReference(indexPath,
      { role_description: '古风发饰角色' })).recommendation?.reference_id).toBe('char_3d_0004')
    const styleOnly = await recommendCharacterReference(indexPath,
      { role_description: '古装角色', style: 'ancient' })
    expect(styleOnly).toMatchObject({ status: 'recommended', recommendation: { reference_id: 'char_3d_0004' } })
    expect(styleOnly.reason).toContain('风格候选：ancient')
    expect((await recommendCharacterReference(indexPath,
      { role_description: '现代人物', style: 'urban' })).status).toBe('needs_review')
    expect((await recommendCharacterReference(indexPath,
      { role_description: '古装角色', style: 'ancient', desired_tags: ['不存在'] })).status).toBe('no_match')

    const index = await readIndex(indexPath)
    const entry = firstEntry(index)
    const metadataPath = join(root, String(entry.metadata_relative_path))
    const metadata = asRecord(JSON.parse(await readFile(metadataPath, 'utf8')))
    const roleFit = asRecord(asRecord(entry.search).role_fit)
    const sourcedEra = { value: '现代', source: { kind: 'human_review', record: 'fixture' } }
    roleFit.suitable_eras = [sourcedEra]
    asRecord(metadata.role_fit).suitable_eras = [sourcedEra]
    entry.status = 'approved'
    entry.reuse_approved = true
    entry.rights_status = 'confirmed'
    metadata.status = 'approved'
    await writeIndex(indexPath, index)
    await writeFile(metadataPath, JSON.stringify(metadata))
    const approved = await recommendCharacterReference(indexPath,
      { role_description: '现代西装领带角色', style: 'urban', desired_tags: ['领带'], era: '现代' })
    expect(approved.status).toBe('recommended')
    expect(approved.uncertainty.join(' ')).not.toContain('待审核')
    expect(approved.uncertainty.join(' ')).not.toContain('复用权利尚未确认')

    roleFit.avoid_eras = [sourcedEra]
    asRecord(metadata.role_fit).avoid_eras = [sourcedEra]
    await writeIndex(indexPath, index)
    await writeFile(metadataPath, JSON.stringify(metadata))
    expect((await recommendCharacterReference(indexPath,
      { role_description: '现代角色', style: 'urban', desired_tags: ['领带'], era: '现代' })).status).toBe('no_match')

    roleFit.avoid_eras = []
    roleFit.unconfirmed_eras = [sourcedEra]
    asRecord(metadata.role_fit).avoid_eras = []
    asRecord(metadata.role_fit).unconfirmed_eras = [sourcedEra]
    await writeIndex(indexPath, index)
    await writeFile(metadataPath, JSON.stringify(metadata))
    expect((await recommendCharacterReference(indexPath,
      { role_description: '现代角色', style: 'urban', desired_tags: ['领带'], era: '现代' })).status).toBe('no_match')

    entry.reuse_approved = true
    entry.rights_status = 'unconfirmed'
    roleFit.unconfirmed_eras = []
    asRecord(metadata.role_fit).unconfirmed_eras = []
    await writeIndex(indexPath, index)
    await writeFile(metadataPath, JSON.stringify(metadata))
    const rightsUnknown = await recommendCharacterReference(indexPath,
      { role_description: '西装领带角色', desired_tags: ['领带'] })
    expect(rightsUnknown.uncertainty.join(' ')).toContain('复用权利尚未确认')
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

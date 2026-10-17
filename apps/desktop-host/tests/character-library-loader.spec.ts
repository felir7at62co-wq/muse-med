/**
 * REAL-composition evidence for the read-only character-reference path.
 *
 * A temporary cordis.yml boots the real domain, model tools, filesystem skill
 * provider and skill loader. The object and attachment stores are in-memory
 * fakes that record operations; no TOS, provider, or paid path participates.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import CharacterLibrary, { CharacterLibraryObjectStore, URBAN_PREFIX } from '@deepseek-ai/dsh-character-library'
import type { CharacterLibraryObjectGet, CharacterLibraryObjectHead, CharacterLibraryObjectListPage, CharacterLibraryObjectListRequest } from '@deepseek-ai/dsh-character-library'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as CharacterReferenceTool from '@deepseek-ai/dsh-tool-character-reference'

import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import Tools from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const metadataKey = `${URBAN_PREFIX}char_urban_lead_001/metadata.json`
const secondMetadataKey = `${URBAN_PREFIX}char_urban_lead_002/metadata.json`
const imageKey = `${URBAN_PREFIX}char_urban_lead_001/portrait.png`
const secondImageKey = `${URBAN_PREFIX}char_urban_lead_002/portrait.png`
const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z1D/HwAF/gJ+fM5MPgAAAABJRU5ErkJggg==',
  'base64',
)
const imageDigest = createHash('sha256').update(imageBytes).digest('hex')
const metadata = (id: string) => ({
  schema_version: 2,
  id,
  images: [{ filename: 'portrait.png', sha256: imageDigest, bytes: imageBytes.byteLength }],
  source: { platform: 'synthetic-loader-test', rights_status: 'unconfirmed' },
  status: 'pending_review',
  category: '甜宠女主',
  style: 'modern sweet',
  era: ['modern'],
  gender: 'female',
  appearance: {
    descriptors: [
      { value: '温柔', source: { kind: 'synthetic-loader-test' } },
      { value: '少女感', source: { kind: 'synthetic-loader-test' } },
    ],
  },
  tags: ['甜妹'],
})
const metadataBytes = Buffer.from(JSON.stringify(metadata('char_urban_lead_001')))
const secondMetadataBytes = Buffer.from(JSON.stringify(metadata('char_urban_lead_002')))

interface StoredObject {
  readonly data: Uint8Array
  readonly contentType: string
  readonly etag: string
}

class LoaderFixtureStore extends CharacterLibraryObjectStore {
  readonly calls: string[] = []
  protected readonly objects = new Map<string, StoredObject>([
    [metadataKey, { data: metadataBytes, contentType: 'application/json',
      etag: createHash('sha256').update(metadataBytes).digest('hex') }],
    [secondMetadataKey, { data: secondMetadataBytes, contentType: 'application/json',
      etag: createHash('sha256').update(secondMetadataBytes).digest('hex') }],
    [imageKey, { data: imageBytes, contentType: 'image/png', etag: imageDigest }],
    [secondImageKey, { data: imageBytes, contentType: 'image/png', etag: imageDigest }],
  ])

  status() {
    return { readConfigured: true, writeConfigured: false }
  }

  async list(request: CharacterLibraryObjectListRequest): Promise<CharacterLibraryObjectListPage> {
    this.calls.push(`list:${request.prefix}`)
    return {
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(request.prefix))
        .map(([key, value]) => ({ key, bytes: value.data.byteLength, etag: value.etag })),
      nextCursor: null,
    }
  }

  async head(key: string): Promise<CharacterLibraryObjectHead | null> {
    this.calls.push(`head:${key}`)
    const value = this.objects.get(key)
    return value === undefined ? null : {
      key,
      bytes: value.data.byteLength,
      etag: value.etag,
      contentType: value.contentType,
    }
  }

  async get(key: string, maxBytes: number): Promise<CharacterLibraryObjectGet> {
    this.calls.push(`get:${key}`)
    const value = this.objects.get(key)
    if (value === undefined || value.data.byteLength > maxBytes) {
      throw new Error('fixture object unavailable')
    }
    return {
      key,
      data: value.data.slice(),
      bytes: value.data.byteLength,
      etag: value.etag,
      contentType: value.contentType,
    }
  }
}

class LoaderImageAttachments extends AttachmentStore {
  readonly imageLimits = {
    maxImageBytes: 1024,
    maxImagesPerMessage: 2,
    maxMessageImageBytes: 2048,
    maxImagePixels: 100,
    maxImageDimension: 10,
    mediaTypes: ['image/png'] as const,
  }
  readonly images = new Map<string, StoredImageAttachment>()
  saves = 0

  async validateImage(_input: SaveImageAttachment): Promise<void> {}

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saves++
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${createHash('sha256').update(input.data).digest('hex')}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }
    this.images.set(ref.attachmentId, { ref, data: input.data.slice() })
    return ref
  }

  async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    const stored = this.images.get(ref.attachmentId)
    if (stored === undefined) throw new Error('Loader image attachment unavailable')
    return { ref: stored.ref, data: stored.data.slice() }
  }
}

class LoaderFixtureSettings extends Service {
  constructor(ctx: Context) { super(ctx, 'settings') }

  describe() {
    return [{
      ns: 'drama-settings',
      value: {
        seriesBudgetCents: 400_000,
        deliverySpec: { width: 1440, height: 2560, fps: 60, minBitrateMbps: 4.6 },
      },
    }]
  }
}

/** Scripted, keyless model boundary: it cannot issue a paid or network request. */
class ScriptedMockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly paidRequests = 0

  constructor(private readonly script: StreamChunk[][], private readonly imageCapable = false) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: 'Scripted mock (no provider)',
      inputModalities: this.imageCapable ? ['text', 'image'] : ['text'] })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.script.shift()
    if (response === undefined) throw new Error('Scripted mock response exhausted')
    for (const chunk of response) yield chunk
  }
}

function scriptedToolCall(name: string, args: object): StreamChunk[] {
  const id = ToolCallId(`scripted-character-${name}-call`)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function scriptedText(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

const roots: string[] = []
const contexts: Context[] = []
let networkCalls = 0
let restoreNetwork: (() => void) | undefined

beforeEach(() => {
  networkCalls = 0
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    networkCalls++
    throw new Error('network forbidden')
  })
  restoreNetwork = () => { network.mockRestore() }
})

afterEach(async () => {
  try {
    for (const context of contexts.splice(0).reverse()) await context.fiber.dispose()
    for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true })
    expect(networkCalls).toBe(0)
  } finally {
    restoreNetwork?.()
    restoreNetwork = undefined
  }
})

async function loadFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-character-library-loader-')))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  const skillRoot = fileURLToPath(new URL('../../../packages/drama/skills/skills/', import.meta.url))
  await writeFile(join(root, 'project_config.json'), `${JSON.stringify({
    project_bible: {
      schema_version: 1,
      revision: 1,
      initial_budget_cents: 400_000,
      delivery: { width: 1440, height: 2560, fps: 60, min_bitrate_mbps: 4.6 },
      characters: [
        { character_id: 'heroine', name: '女主', role_class: 'lead' },
        { character_id: 'support-01', name: '同事', role_class: 'support' },
      ],
    },
  }, null, 2)}\n`)
  await writeFile(configPath, [
    "- name: 'fixture:character-library-store'",
    "- name: 'fixture:image-attachments'",
    "- name: 'fixture:settings'",
    "- name: '@deepseek-ai/dsh-character-library'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-skill'",
    "- name: '@deepseek-ai/dsh-skill-filesystem'",
    '  config:',
    '    includeDefaultRoots: false',
    '    watch: false',
    '    customSkillDirs:',
    `      - ${JSON.stringify(skillRoot)}`,
    "- name: '@deepseek-ai/dsh-tool-skill'",
    "- name: '@deepseek-ai/dsh-tool-character-reference'",
    '',
  ].join('\n'))

  const context = new Context()
  contexts.push(context)
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['fixture:character-library-store', LoaderFixtureStore],
    ['fixture:image-attachments', LoaderImageAttachments],
    ['fixture:settings', LoaderFixtureSettings],
    ['@deepseek-ai/dsh-character-library', CharacterLibrary],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-skill', SkillRegistry],
    ['@deepseek-ai/dsh-skill-filesystem', SkillFilesystem],
    ['@deepseek-ai/dsh-tool-skill', ToolSkill],
    ['@deepseek-ai/dsh-tool-character-reference', CharacterReferenceTool],
  ])
  context.loader.internal = {
    version: 'v2',
    loadCache: new Map(),
    register() { throw new Error('Unexpected Loader hook registration') },
    getOrCreateModuleJob() { throw new Error('Unexpected Loader module job') },
    resolveSync() { throw new Error('Unexpected Loader resolution') },
    load() { throw new Error('Unexpected Loader load') },
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  }
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()
  const unloaded = [...context.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  const store = context.get('characterLibraryObjectStore')
  expect(store).toBeInstanceOf(LoaderFixtureStore)
  if (!(store instanceof LoaderFixtureStore)) throw new Error('Loader fixture store did not mount')
  await context.plugin(LlmRuntime)
  await context.plugin(SessionStore)
  await context.plugin(SessionProjectionRegistry)
  await context.plugin(AgentLoop, { agents: [] })
  const agent = await context.agentLoop.create(SessionId('character-reference-direct'), {}, { cwd: root })
  return { context, store, agent, root }
}

describe('character library real Loader composition', () => {

  it('loads the Skill and returns bounded pending candidates without network or writes', async () => {
    const { context, store, agent } = await loadFixture()
    expect((await context.skills.list()).map(skill => skill.name)).toContain('character-reference-library')
    expect(context.tools.get('drama_character_references')).toBeDefined()
    expect(context.tools.get('drama_character_reference_view')).toBeDefined()

    const skill = await context.tools.execute({
      callId: ToolCallId('load-character-reference-library-skill'),
      name: 'skill',
      arguments: { name: 'character-reference-library' },
      signal: new AbortController().signal,
    })
    expect(skill.isError, JSON.stringify(skill.content)).not.toBe(true)
    expect(skill.value).toMatchObject({
      name: 'character-reference-library',
    })
    expect(JSON.stringify(skill.value)).toContain('pending_review')
    expect(JSON.stringify(skill.value)).toContain('drama_character_reference_view')
    expect(JSON.stringify(skill.value)).not.toContain('drama_character_library_ingest_current_file')

    const recommendation = await context.tools.execute({
      callId: ToolCallId('recommend-character-reference'),
      name: 'drama_character_references',
      arguments: {
        character_id: 'heroine',
        role_description: '现代甜宠女主，年轻，温柔，有少女感',
        role_class: 'lead',
        collection: 'urban',
        required_era: 'modern',
        gender: 'female',
        trait_terms: ['温柔', '少女感'],
        role_terms: ['甜宠女主'],
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(recommendation.isError, JSON.stringify(recommendation.content)).not.toBe(true)
    expect(recommendation.value).toMatchObject({
      status: 'candidates',
      character_id: 'heroine',
      candidates: [
        { original_asset_id: 'char_urban_lead_001', image_sha256: imageDigest,
          metadata_status: 'pending_review' },
        { original_asset_id: 'char_urban_lead_002', image_sha256: imageDigest,
          metadata_status: 'pending_review' },
      ],
      read_only: true,
      can_publish: false,
      can_reuse: false,
      can_bind: false,
      apply_allowed: false,
      local_writes: 0,
      remote_writes: 0,
      paid_requests: 0,
    })
    const candidates = (recommendation.value as { candidates: { catalog_asset_id: string }[] }).candidates
    expect(candidates.map(candidate => candidate.catalog_asset_id)).toEqual([
      'character:muse-character-reference-qa:char_urban_lead_001',
      'character:muse-character-reference-qa:char_urban_lead_002',
    ])
    expect(candidates.length).toBeLessThanOrEqual(3)
    expect(JSON.stringify(recommendation.value)).not.toMatch(/metadataKey|imageKey|metadata\.json|portrait\.png/u)
    expect(store.calls).toContain(`list:${URBAN_PREFIX}`)
    expect(store.calls).toContain(`get:${metadataKey}`)
    expect(store.calls).toContain(`get:${secondMetadataKey}`)
    expect(networkCalls).toBe(0)
    expect(store.calls.some(call => call.startsWith('unexpected:'))).toBe(false)
  })

  it('logs a keyless scripted-mock Agent Session with candidate search and actual image attachment', async () => {
    const { context, store, root } = await loadFixture()
    const userText = '请为现代甜宠短剧的年轻温柔女主选择一个有少女感的人物参考。'
    const finalText = '脚本化模拟结果：已查看候选图，选择 char_urban_lead_001 作为参考。该素材仍是 pending_review，不能发布、复用、绑定或应用。'
    const adapter = new ScriptedMockAdapter([
      scriptedToolCall('drama_character_references', {
        character_id: 'heroine',
        role_description: '现代甜宠女主，年轻，温柔，有少女感',
        role_class: 'lead',
        collection: 'urban',
        required_era: 'modern',
        gender: 'female',
        trait_terms: ['温柔', '少女感'],
        role_terms: ['甜宠女主'],
      }),
      scriptedToolCall('drama_character_reference_view', {
        catalog_asset_id: 'character:muse-character-reference-qa:char_urban_lead_001',
        expected_sha256: imageDigest,
      }),
      scriptedText(finalText),
    ], true)

    context.llm.registerAdapter(['scripted-mock'], adapter)
    const agent = await context.agentLoop.create(SessionId('character-reference-scripted-mock'), {
      provider: 'scripted-mock',
      model: 'scripted-mock',
    }, { cwd: root })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: userText }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(3)
    expect(adapter.paidRequests).toBe(0)
    expect(adapter.requests[0]?.provider).toBe('scripted-mock')
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('drama_character_references')
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('drama_character_reference_view')
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain(userText)

    const toolResult = adapter.requests[1]?.messages.find(message => message.role === 'tool')
    expect(toolResult?.content).toHaveLength(1)
    const toolText = toolResult?.content[0]
    if (toolText?.type !== 'text') throw new Error('Expected one text tool result')
    expect(JSON.parse(toolText.text)).toMatchObject({
      status: 'candidates',
      candidates: [
        { original_asset_id: 'char_urban_lead_001', image_sha256: imageDigest,
          metadata_status: 'pending_review' },
        { original_asset_id: 'char_urban_lead_002', image_sha256: imageDigest,
          metadata_status: 'pending_review' },
      ],
      read_only: true,
      can_publish: false,
      can_reuse: false,
      can_bind: false,
      apply_allowed: false,
      local_writes: 0,
      remote_writes: 0,
      paid_requests: 0,
    })
    const viewed = adapter.requests[2]?.messages.findLast(message => message.role === 'tool')
    expect(viewed?.content).toHaveLength(2)
    expect(viewed?.content[0]).toMatchObject({ type: 'text' })
    expect(viewed?.content[1]).toMatchObject({ type: 'image',
      attachment: { mediaType: 'image/png', bytes: imageBytes.byteLength } })
    const viewText = viewed?.content[0]
    if (viewText?.type !== 'text') throw new Error('Expected view metadata before image attachment')
    expect(JSON.parse(viewText.text)).toMatchObject({
      catalog_asset_id: 'character:muse-character-reference-qa:char_urban_lead_001',
      image_sha256: imageDigest,
      metadata_status: 'pending_review',
      can_bind: false,
      source_read_only: true,
      tos_writes: 0,
      paid_requests: 0,
      image_attached: true,
    })
    const attachment = context.get('attachments')
    expect(attachment).toBeInstanceOf(LoaderImageAttachments)
    if (!(attachment instanceof LoaderImageAttachments)) throw new Error('Loader image store did not mount')
    expect(attachment.saves).toBe(1)
    const imageBlock = viewed?.content[1]
    if (imageBlock?.type !== 'image') throw new Error('Expected an actual image attachment tool result')
    expect([...(await attachment.readImage(imageBlock.attachment)).data]).toEqual([...imageBytes])
    expect(JSON.stringify(viewed?.content)).not.toMatch(/metadataKey|imageKey|metadata\.json|portrait\.png|base64/u)

    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'tool/call')).toHaveLength(2)
    expect(events.filter(event => event.type === 'tool/result')).toHaveLength(2)
    const final = agent.session.deriveMessages().findLast(message => message.role === 'assistant')
    expect(final?.content).toEqual([{ type: 'text', text: finalText }])
    expect(finalText.match(/char_urban_lead_001/gu)).toHaveLength(1)

    expect(store.calls).toContain(`get:${imageKey}`)
    expect(store.calls).toContain(`list:${URBAN_PREFIX}`)
    expect(store.calls.some(call => call.startsWith('unexpected:'))).toBe(false)
    expect(networkCalls).toBe(0)
  })

  it('skips a non-lead role without an exception and disposes every registry contribution', async () => {
    const { context, store, agent } = await loadFixture()
    const skipped = await context.tools.execute({
      callId: ToolCallId('skip-supporting-reference'),
      name: 'drama_character_references',
      arguments: {
        character_id: 'support-01',
        role_description: '主角身边的普通同事',
        role_class: 'support',
        collection: 'urban',
      },
      agent,
      signal: new AbortController().signal,
    })
    expect(skipped.isError, JSON.stringify(skipped.content)).not.toBe(true)
    expect(skipped.value).toMatchObject({
      status: 'no_match',
      uncertainty: ['supporting_role_default_skip'],
      can_bind: false,
      apply_allowed: false,
    })
    expect(store.calls).toEqual([])

    const entries = [...context.loader.entries()]
    const characterTool = entries.find(entry => entry.options.name === '@deepseek-ai/dsh-tool-character-reference')
    const skillProvider = entries.find(entry => entry.options.name === '@deepseek-ai/dsh-skill-filesystem')
    const library = entries.find(entry => entry.options.name === '@deepseek-ai/dsh-character-library')
    if (characterTool?.fiber === undefined || skillProvider?.fiber === undefined || library?.fiber === undefined) {
      throw new Error('Expected Loader-owned fibers were not mounted')
    }

    await characterTool.fiber.dispose()
    expect(context.tools.get('drama_character_references')).toBeUndefined()
    expect(context.tools.get('drama_character_reference_view')).toBeUndefined()
    await skillProvider.fiber.dispose()
    expect(await context.skills.get('character-reference-library')).toBeUndefined()
    await library.fiber.dispose()
    expect(context.get('characterLibrary')).toBeUndefined()
  })
})

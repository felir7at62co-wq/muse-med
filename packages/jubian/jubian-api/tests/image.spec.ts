import { describe, expect, it } from 'vitest'
import { buildImageRequest, imageCandidates, readImageDisplayPrice, resolveImageModel, resolveImageStyle } from '../src/image.ts'

const CATALOGUE = [{ id: 42, standardId: 42, modelId: 'gpt-image-2', platformId: 'YU_DIAN', unitPrice: 0.5, unit: '张',
  genTypes: [{ id: 7, type: 3 }],
  videoStandards: [
    { id: 90, ratio: '16:9', resolution: '2K', width: 2048, height: 1152, genNum: 1 },
    { id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 },
    { id: 93, ratio: '9:16', resolution: '1K', width: 720, height: 1280, genNum: 1 },
  ] }]

// The live account catalogue: one model id, two platforms, two prices.
const MULTI = [
  { id: 66, modelId: 'gpt-image-2', platformId: 'KU_AI', unitPrice: 0.12, unit: '张',
    genTypes: [{ id: 7, type: 3 }],
    videoStandards: [{ id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] },
  { id: 76, modelId: 'gpt-image-2', platformId: 'DUO_YUAN_TAN_SUO', unitPrice: 1.05, unit: '条',
    genTypes: [{ id: 8, type: 3 }],
    videoStandards: [{ id: 92, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] },
]

describe('resolveImageModel', () => {
  it.each([{ ratio: '9:16' }, { resolution: '8K' }, { resolution: null }, { width: 0 }, { width: 8193 },
    { width: 1.5 }, { width: '1280' }, { width: 1281 }, { height: 0 }, { height: 8193 }, { height: 1.5 },
    { height: '720' }, { height: 721 }, { width: 1280, height: 736 }])
  ('rejects unsupported image dimensions or specifications %j', (overrides) => {
    const row = CATALOGUE[0]!
    expect(() => resolveImageModel([{ ...row, videoStandards: [{ ...row.videoStandards[1], ...overrides }] }])).toThrow()
  })

  it('reads decimal catalogue selectors and tolerates absent generation selectors', () => {
    const row = CATALOGUE[0]!
    expect(resolveImageModel([{ ...row, id: undefined, standardId: '42', genTypes: null }]))
      .toMatchObject({ standardId: 42, modelGenerationTypeId: null })
    expect(resolveImageModel([{ ...row, genTypes: [{ type: 3 }] }])).toMatchObject({ modelGenerationTypeId: null })
    expect(resolveImageModel([{ ...row, genTypes: [{ type: 3, id: null }] }])).toMatchObject({ modelGenerationTypeId: null })
    expect(resolveImageModel([{ ...row, genTypes: undefined }])).toMatchObject({ modelGenerationTypeId: null })
  })

  it('refuses duplicate generation selectors and duplicate resolution standards', () => {
    const row = CATALOGUE[0]!
    expect(() => resolveImageModel([{ ...row, genTypes: [row.genTypes[0], row.genTypes[0]] }])).toThrow()
    expect(() => resolveImageModel([{ ...row, videoStandards: [row.videoStandards[1], row.videoStandards[1]] }])).toThrow()
    expect(() => resolveImageModel(null)).toThrow()
    expect(() => resolveImageModel([null])).toThrow()
  })

  it('names incomplete catalogue candidates without inventing their metadata', () => {
    const row = { modelId: 'gpt-image-2' }
    expect(() => resolveImageModel([row, row])).toThrow('standardId=? platformId=? unitPrice=? unit=?')
    expect(() => resolveImageModel([{ ...row, id: '42', unitPrice: '0.5', unit: '' }, row]))
      .toThrow('standardId=42 platformId=? unitPrice=0.5 unit=?')
  })
  it('selects the lowest supported resolution with valid 16:9 dimensions', () => {
    expect(resolveImageModel(CATALOGUE)).toEqual({ standardId: 42, modelId: 'gpt-image-2', platformId: 'YU_DIAN',
      modelGenerationTypeId: 7, genType: 3, videoStandardId: 91, resolution: '1K' })
  })

  it('selects the requested 9:16 specification from the same model and price row', () => {
    expect(resolveImageModel(CATALOGUE, {}, '9:16')).toEqual({ standardId: 42, modelId: 'gpt-image-2',
      platformId: 'YU_DIAN', modelGenerationTypeId: 7, genType: 3, videoStandardId: 93, resolution: '1K' })
  })

  it('refuses 9:16 when the selected model row has no matching specification', () => {
    const landscapeOnly = [{ ...CATALOGUE[0]!, videoStandards: [CATALOGUE[0]!.videoStandards[1]] }]
    expect(() => resolveImageModel(landscapeOnly, {}, '9:16')).toThrow(/9:16/u)
  })

  it('rejects a standard whose dimensions are not exactly 16:9', () => {
    const broken = [{ ...CATALOGUE[0], videoStandards: [{ id: 1, ratio: '16:9', resolution: '1K', width: 1280, height: 721 }] }]
    expect(() => resolveImageModel(broken)).toThrow()
  })

  it('rejects a catalogue without exactly one gpt-image-2 row', () => {
    expect(() => resolveImageModel([])).toThrow()
    expect(() => resolveImageModel([CATALOGUE[0], CATALOGUE[0]])).toThrow()
  })
})

describe('resolveImageModel against a catalogue listing several gpt-image-2 rows', () => {
  it('refuses to pick a platform and names every candidate with its own price', () => {
    let message = ''
    try { resolveImageModel(MULTI) } catch (error) { message = (error as Error).message }
    // Choosing here would silently buy from one platform at one price; the
    // failure has to carry enough for a deployment to pin the other.
    for (const token of ['66', 'KU_AI', '0.12', '76', 'DUO_YUAN_TAN_SUO', '1.05']) {
      expect(message).toContain(token)
    }
  })

  it('selects the pinned platform or standard and reports that row alone', () => {
    expect(resolveImageModel(MULTI, { platformId: 'KU_AI' }))
      .toMatchObject({ standardId: 66, platformId: 'KU_AI', videoStandardId: 91, modelGenerationTypeId: 7 })
    expect(resolveImageModel(MULTI, { standardId: 76 }))
      .toMatchObject({ standardId: 76, platformId: 'DUO_YUAN_TAN_SUO', videoStandardId: 92,
        modelGenerationTypeId: 8 })
  })

  it('quotes the pinned row and never the other platform price', () => {
    expect(readImageDisplayPrice(MULTI, { platformId: 'KU_AI' }))
      .toEqual({ status: 'available', unit_price: 0.12, unit: '张', quote_verified: false })
    expect(readImageDisplayPrice(MULTI, { standardId: 76 }))
      .toEqual({ status: 'available', unit_price: 1.05, unit: '条', quote_verified: false })
  })

  it('rejects a pin that matches no candidate instead of falling back to one', () => {
    expect(() => resolveImageModel(MULTI, { platformId: 'YU_DIAN' })).toThrow(/KU_AI/)
    expect(() => resolveImageModel(MULTI, { standardId: 42 })).toThrow(/DUO_YUAN_TAN_SUO/)
  })

  it('builds the body from the pinned row', () => {
    const body = buildImageRequest({ scriptId: 1, assetName: 'x', assetType: 1, prompt: 'p', references: [] },
      MULTI, { standardId: 76 })
    const config = JSON.parse(body.modelConfig as string) as Record<string, unknown>
    expect(config).toMatchObject({ standardId: 76, platformId: 'DUO_YUAN_TAN_SUO', videoStandardId: 92,
      modelGenerationTypeId: 8 })
  })
})

describe('buildImageRequest', () => {
  it('refuses more than five KU_AI references before a paid request is constructed', () => {
    const input = { scriptId: 1, assetName: 'staging', assetType: 2, prompt: 'p',
      references: Array.from({ length: 6 }, (_, i) => `https://media.example/${i}.png`) }
    expect(() => buildImageRequest(input, MULTI, { platformId: 'KU_AI' })).toThrow('at most 5')
    expect(buildImageRequest({ ...input, references: input.references.slice(0, 5) }, MULTI,
      { platformId: 'KU_AI' })).toHaveProperty('modelConfig')
    expect(buildImageRequest(input, MULTI, { standardId: 76 })).toHaveProperty('modelConfig')
  })
  const request = { scriptId: 1, assetName: 'lead', assetType: 1, prompt: 'ready', references: [] }

  it.each([{ scriptId: 0 }, { assetType: 0 }, { parentAssetId: 0 }, { assetName: '' }, { assetName: '\ud800' },
    { assetName: 'bad\nname' }, { prompt: '' }, { prompt: 'bad\u0000prompt' }])
  ('refuses unusable local image request fields %j', (overrides) => {
    expect(() => buildImageRequest({ ...request, ...overrides }, CATALOGUE)).toThrow()
  })

  it.each(['not-a-url', 'https://media.example/a.png#fragment', 'https://media.example/a b.png',
    'https://media.example/a\\b.png', 'https://user@media.example/a.png', 'https://:secret@media.example/a.png'])
  ('refuses unsafe image references %s', (reference) => {
    expect(() => buildImageRequest({ ...request, references: [reference] }, CATALOGUE)).toThrow()
  })

  it('accepts multiline prompts while preserving the exact text', () => {
    const body = buildImageRequest({ ...request, prompt: 'first line\nsecond\tline' }, CATALOGUE)
    const config = JSON.parse(String(body.modelConfig)) as Record<string, unknown>
    expect(config.prompt).toBe('first line\nsecond\tline')
  })
  it('builds the exact create body with a deterministic modelConfig string', () => {
    const body = buildImageRequest({ scriptId: 2708, assetName: '陆沉舟', assetType: 1,
      prompt: '一位中年男性', references: [] }, CATALOGUE)
    expect(body).toMatchObject({ scriptId: 2708, assetName: '陆沉舟', assetType: 1, isLocal: 0, isGenerate: 1 })
    const config = JSON.parse(body.modelConfig as string) as Record<string, unknown>
    expect(config).toMatchObject({ modelId: 'gpt-image-2', genType: 3, duration: 1, resolution: '1K', ratio: '16:9',
      genNum: 1, backupModelList: [], style: 0, quality: '', prompt: '一位中年男性', materialList: [] })
    expect(config.standardId).toBe(42)
    expect(config.videoStandardId).toBe(91)
  })

  it('keeps the default and explicit 16:9 wire bodies identical', () => {
    const omitted = buildImageRequest(request, CATALOGUE)
    const explicit = buildImageRequest({ ...request, aspectRatio: '16:9' }, CATALOGUE)
    expect(explicit).toEqual(omitted)
  })

  it('builds a 9:16 body with its own specification and ordered reference URLs', () => {
    const body = buildImageRequest({ ...request, aspectRatio: '9:16',
      references: ['https://example.test/identity.png', 'https://example.test/location.png'] }, CATALOGUE)
    const config = JSON.parse(body.modelConfig as string) as Record<string, unknown>
    expect(config).toMatchObject({ standardId: 42, videoStandardId: 93, ratio: '9:16', resolution: '1K',
      materialList: [
        { materialUrl: 'https://example.test/identity.png', materialType: 'image', sortOrder: 1 },
        { materialUrl: 'https://example.test/location.png', materialType: 'image', sortOrder: 2 },
      ] })
  })

  it('refuses an unsupported requested aspect ratio locally', () => {
    expect(() => buildImageRequest({ ...request, aspectRatio: '4:3' as '9:16' }, CATALOGUE))
      .toThrow(/image_aspect_ratio/u)
  })

  it('numbers ordered references from one and rejects a non-HTTPS url', () => {
    const body = buildImageRequest({ scriptId: 1, assetName: 'x', assetType: 1, prompt: 'p',
      references: ['https://x/a.png', 'https://x/b.png'] }, CATALOGUE)
    const config = JSON.parse(body.modelConfig as string) as { materialList: { sortOrder: number }[] }
    expect(config.materialList.map(row => row.sortOrder)).toEqual([1, 2])
    expect(() => buildImageRequest({ scriptId: 1, assetName: 'x', assetType: 1, prompt: 'p',
      references: ['http://x/a.png'] }, CATALOGUE)).toThrow()
  })

  it('adds the parent id only for the update route', () => {
    expect(buildImageRequest({ scriptId: 1, assetName: 'x', assetType: 1, prompt: 'p', references: [],
      parentAssetId: 83749 }, CATALOGUE).id).toBe(83749)
    expect('id' in buildImageRequest({ scriptId: 1, assetName: 'x', assetType: 1, prompt: 'p', references: [] }, CATALOGUE))
      .toBe(false)
  })
})

describe('readImageDisplayPrice', () => {
  it('reports the display price without claiming it is a verified quote', () => {
    expect(readImageDisplayPrice(CATALOGUE)).toEqual({ status: 'available', unit_price: 0.5, unit: '张', quote_verified: false })
    expect(readImageDisplayPrice([{ ...CATALOGUE[0], unitPrice: 'free' }]))
      .toEqual({ status: 'unavailable', quote_verified: false })
  })

  it('reports an unquotable row as unavailable whatever the price says', () => {
    expect(readImageDisplayPrice([{ ...CATALOGUE[0], unit: 'x'.repeat(129) }]))
      .toEqual({ status: 'unavailable', quote_verified: false })
    expect(readImageDisplayPrice([{ ...CATALOGUE[0], unit: ' \u0000 ' }]))
      .toEqual({ status: 'unavailable', quote_verified: false })
  })
})

describe('imageCandidates', () => {
  it('lists every gpt-image-2 row with its own platform and price, and no other model', () => {
    const other = { id: 35, modelId: 'doubao-seedream-4-0-250828', platformId: 'FANG_ZHOU',
      unitPrice: 0.116, unit: '元/张' }
    expect(imageCandidates([...MULTI, other])).toEqual([
      { standardId: 66, platformId: 'KU_AI', unitPrice: 0.12, unit: '张' },
      { standardId: 76, platformId: 'DUO_YUAN_TAN_SUO', unitPrice: 1.05, unit: '条' },
    ])
    expect(imageCandidates([])).toEqual([])
  })

  it('leaves a price or unit the catalogue does not state out of the entry', () => {
    expect(imageCandidates([{ id: 66, modelId: 'gpt-image-2', platformId: 'KU_AI', unitPrice: '0.12' }]))
      .toEqual([{ standardId: 66, platformId: 'KU_AI', unitPrice: null, unit: null }])
  })

  it('rejects a matching row without a usable id or platform', () => {
    expect(() => imageCandidates([{ modelId: 'gpt-image-2', platformId: 'KU_AI' }])).toThrow()
    expect(() => imageCandidates([{ id: 66, modelId: 'gpt-image-2' }])).toThrow()
  })
})


describe('image medium selection', () => {
  it.each([
    ['项目风格：3D动漫／风格化三维动画，PBR材质。角色身份：女主。', 1],
    ['项目风格: 动漫，水墨线条与二维平涂。角色身份：男主。', 1],
    ['  项目风格： stylized 3D animation, soft lighting.\nCharacter reference.', 1],
    ['项目风格：真人实拍，人物摄影。', 0],
  ])('preserves an official leading project style in %s', (prompt, style) => {
    const body = buildImageRequest({ scriptId: 4908, assetName: '风格样图', assetType: 1,
      prompt, references: [] }, CATALOGUE)
    expect(JSON.parse(String(body.modelConfig))).toMatchObject({ style, prompt })
  })

  it.each(['构图说明：项目风格：3D动漫，角色。', '项目风格：不要3D动漫，要人物摄影。',
    '项目风格：\n3D动漫，角色。', '项目风格 ：3D动漫，角色。', '项目风格：禁止真人摄影，3D动漫。'])
  ('does not infer a medium from non-leading or negative project style wording %s', (prompt) => {
    expect(resolveImageStyle(prompt)).toBe('live_action')
    expect(resolveImageStyle(prompt, 'anime')).toBe('anime')
  })

  it('rejects an explicit medium conflicting with an official leading project style', () => {
    expect(() => resolveImageStyle('项目风格：3D动漫，角色。', 'live_action')).toThrow('conflicts')
    expect(() => resolveImageStyle('项目风格: 真人实拍，场景。', 'anime')).toThrow('conflicts')
  })

  it.each(['3D动漫／风格化三维动画，PBR材质。', '【动漫】3D角色设定图。',
    '三维动画，精细CG建模。', '风格化三维动画，电影光照。', 'stylized 3D animation character.',
    '动漫，纯环境场景。', '动画：同一项目道具。', '3D国漫，角色立绘。'])
  ('keeps a leading anime medium in the provider selector without rewriting %s', (prompt) => {
    const body = buildImageRequest({ scriptId: 4908, assetName: '角色小样', assetType: 1,
      prompt, references: [] }, CATALOGUE)
    const config: unknown = JSON.parse(String(body.modelConfig))
    expect(config).toMatchObject({ style: 1, prompt })
  })

  it.each(['【真人】人物摄影。', '【真人写实】真人摄影。', '真人实拍，人物设定。',
    'photorealistic portrait photography of a character.', 'live-action portrait.'])
  ('retains live action for a declared photography medium %s', (prompt) => {
    expect(resolveImageStyle(prompt)).toBe('live_action')
  })

  it('uses an explicit anime choice for neutral PBR wording and retains legacy unmarked requests', () => {
    expect(resolveImageStyle('自然比例，精细皮肤材质，photorealistic lighting。', 'anime')).toBe('anime')
    expect(resolveImageStyle('一位中年男性')).toBe('live_action')
    expect(resolveImageStyle('一位中年男性', 'live_action')).toBe('live_action')
    expect(resolveImageStyle('【动漫】3D动漫角色。', 'anime')).toBe('anime')
    expect(resolveImageStyle('  3D动漫，第一行。\n不要真人摄影。')).toBe('anime')
    const body = buildImageRequest({ scriptId: 4908, assetName: '中性措辞', assetType: 1,
      prompt: '人物设定图，精细PBR材质。', references: [], imageStyle: 'anime', parentAssetId: 169279 }, CATALOGUE)
    const config: unknown = JSON.parse(String(body.modelConfig))
    expect(config).toMatchObject({ style: 1 })
    expect(body.id).toBe(169279)
  })

  it('rejects a conflicting explicit medium before building a generation request', () => {
    expect(() => resolveImageStyle('3D动漫，角色。', 'live_action')).toThrow('conflicts')
    expect(() => resolveImageStyle('【真人写实】摄影风格。', 'anime')).toThrow('conflicts')
    expect(() => resolveImageStyle('人物设定图', 'unsupported')).toThrow('image_style')
  })
})

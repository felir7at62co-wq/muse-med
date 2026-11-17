import { describe, expect, it } from 'vitest'
import { MANUSCRIPT_PRODUCER_TYPES, MANUSCRIPT_SCRIPT_FORMATS, MANUSCRIPT_TAG_CATEGORIES,
  buildBindableManuscriptsRequest, buildManuscriptDetailRequest, buildManuscriptFileRequest,
  buildManuscriptStartProduceRequest, buildManuscriptTagOptionsRequest,
  buildManuscriptUploadRequest, readBindableManuscripts, readManuscriptDetail, readManuscriptFile,
  readManuscriptTagOptions, type ManuscriptTagOptions, type ManuscriptUploadInput } from '../src/manuscript.ts'

const OPTIONS: ManuscriptTagOptions = {
  creationType: readManuscriptTagOptions([{ id: 10, tagName: '原创', tagCode: 'original' },
    { id: 11, tagName: '迭代', tagCode: 'iteration' }, { id: 12, tagName: '重写', tagCode: 'rewrite' },
    { id: 13, tagName: '其他改编', tagCode: 'adaptation' }], 'creationType'),
  genre: readManuscriptTagOptions([20, 21, 22, 23, 24].map(id => ({ id, tagName: `题材${id}` })), 'genre'),
  era: readManuscriptTagOptions([{ id: 30, tagName: '现代' }], 'era'),
  audience: readManuscriptTagOptions([{ id: 40, tagName: '通用' }], 'audience'),
}

const INPUT: ManuscriptUploadInput = {
  scriptName: '  剧本名  ', scriptFormat: 4, creationType: 10, producerType: 1,
  episodeCount: 80, genreTagIds: [20, 21], eraTagId: 30, audienceTagId: 40,
  manuscriptFile: { name: '修改后剧本.docx', url: 'https://media.example/manuscript.docx', objectKey: 'prod/docs/manuscript.docx' },
  originalFile: { name: '原小说.doc', url: 'https://media.example/original.doc', objectKey: 'prod/docs/original.doc' },
  hasCopyright: '1', copyrightOwner: '  用户声明的版权方  ',
}

const BODY = {
  scriptName: '剧本名', scriptFormat: 4, creationType: '10', sourceScriptName: null, producerType: 1,
  episodeCount: 80, genreTagIds: '20,21', eraTagIds: '30', audienceTagIds: '40', hasCopyright: '1',
  copyrightOwner: '用户声明的版权方', originalNovelName: '原小说', manuscriptName: '修改后剧本',
  manuscriptFileName: '修改后剧本.docx', manuscriptFileUrl: 'https://media.example/manuscript.docx',
  manuscriptObjectKey: 'prod/docs/manuscript.docx', originalFileName: '原小说.doc',
  originalFileUrl: 'https://media.example/original.doc', originalObjectKey: 'prod/docs/original.doc', assignLeaderId: null,
}

describe('manuscript form metadata', () => {
  it('exposes the static frontend enums without choosing one for the caller', () => {
    expect(MANUSCRIPT_SCRIPT_FORMATS).toEqual([{ value: 1, label: '解说漫（推文）' }, { value: 2, label: '真人剧' },
      { value: 3, label: '3D动态漫' }, { value: 4, label: '仿真人剧' }])
    expect(MANUSCRIPT_PRODUCER_TYPES).toEqual([{ value: 1, label: '杭州' }, { value: 2, label: '厦门' }])
  })

  it.each(MANUSCRIPT_TAG_CATEGORIES)('queries the existing %s category without creating tags', (category) => {
    expect(buildManuscriptTagOptionsRequest(category)).toEqual({ method: 'GET',
      path: `/script/center/tag/listByCategory?tagCategory=${category}` })
  })

  it('reads tag IDs separately from semantic codes and retains unknown fields', () => {
    const source = [{ id: '11', tagName: '迭代', tagCode: 'iteration', tagCategory: 'creationType', custom: { keep: true } }]
    const result = readManuscriptTagOptions(source, 'creationType')
    expect(result).toEqual([{ tag_id: 11, name: '迭代', code: 'iteration', category: 'creationType', snapshot: source[0] }])
    expect(result[0]!.snapshot).not.toBe(source[0])
    expect(result[0]!.snapshot.custom).not.toBe(source[0]!.custom)
  })

  it('accepts an empty category without inventing tag options', () => {
    expect(readManuscriptTagOptions([], 'genre')).toEqual([])
  })

  it.each([null, {}, { rows: [] }, [null], [{ id: 0 }], [{ id: 11 }, { id: 11 }], [{ id: 11, tagCategory: 'genre' }]])
  ('rejects a malformed, duplicated or cross-category tag list %j', (data) => {
    expect(() => readManuscriptTagOptions(data, 'creationType')).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })
})

describe('existing manuscript registration', () => {
  it('builds the production-side record from two uploaded files and explicit metadata', () => {
    expect(buildManuscriptUploadRequest('produce', INPUT, OPTIONS)).toEqual({ method: 'POST',
      path: '/script/center/pool/produceUpload', body: BODY })
    expect(INPUT.scriptName).toBe('  剧本名  ')
    expect(INPUT.genreTagIds).toEqual([20, 21])
  })

  it('uses the editor route only when selected and carries an explicit optional assignment', () => {
    expect(buildManuscriptUploadRequest('editor', { ...INPUT, assignLeaderId: 99 }, OPTIONS))
      .toEqual({ method: 'POST', path: '/script/center/pool/editorUpload', body: { ...BODY, assignLeaderId: 99 } })
    expect(buildManuscriptUploadRequest('editor', INPUT, OPTIONS).body).toEqual(BODY)
    expect(() => buildManuscriptUploadRequest('produce', { ...INPUT, assignLeaderId: 99 }, OPTIONS)).toThrow()
  })

  it('does not infer copyright from file ownership, and preserves the explicit no-copyright declaration', () => {
    expect(buildManuscriptUploadRequest('produce', { ...INPUT, hasCopyright: '0' }, OPTIONS).body)
      .toEqual({ ...BODY, hasCopyright: '0', copyrightOwner: null })
    expect(() => buildManuscriptUploadRequest('produce', { ...INPUT, copyrightOwner: ' ' }, OPTIONS)).toThrow()
    const { copyrightOwner: _owner, ...withoutOwner } = INPUT
    expect(() => buildManuscriptUploadRequest('produce', withoutOwner, OPTIONS)).toThrow()
    const { hasCopyright: _declaration, ...withoutDeclaration } = INPUT
    // @ts-expect-error Copyright selection is mandatory and must not be copied from the UI's default.
    expect(() => buildManuscriptUploadRequest('produce', withoutDeclaration, OPTIONS)).toThrow()
  })

  it.each([11, 12])('requires the source name for the selected semantic creation tag %s', (creationType) => {
    expect(() => buildManuscriptUploadRequest('produce', { ...INPUT, creationType }, OPTIONS)).toThrow()
    expect(buildManuscriptUploadRequest('produce', { ...INPUT, creationType, sourceScriptName: ' 来源故事 ' }, OPTIONS).body)
      .toEqual({ ...BODY, creationType: String(creationType), sourceScriptName: '来源故事' })
  })

  it('matches the original-only form by not sending a hidden source name', () => {
    expect(buildManuscriptUploadRequest('produce', { ...INPUT, sourceScriptName: '隐藏字段' }, OPTIONS).body).toEqual(BODY)
    expect(buildManuscriptUploadRequest('produce', { ...INPUT, creationType: 13 }, OPTIONS).body)
      .toEqual({ ...BODY, creationType: '13' })
  })

  it.each([{ scriptName: ' ' }, { episodeCount: 0 }, { episodeCount: 201 }, { creationType: 999 },
    { genreTagIds: [] }, { genreTagIds: [20, 20] }, { genreTagIds: [20, 21, 22, 23, 24] },
    { genreTagIds: [999] }, { eraTagId: 999 }, { audienceTagId: 999 }])
  ('rejects invalid form values or tag IDs absent from the current lists %j', (change) => {
    expect(() => buildManuscriptUploadRequest('produce', { ...INPUT, ...change }, OPTIONS))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })

  it.each([[{ scriptFormat: 99 as never }, 'scriptFormat'], [{ producerType: 99 as never }, 'producerType'],
    [{ hasCopyright: '2' as never }, 'hasCopyright']] as const)
  ('rejects an unknown script format, producer type or copyright declaration %j', (change, detail) => {
    expect(() => buildManuscriptUploadRequest('produce', { ...INPUT, ...change }, OPTIONS))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT', detail }))
  })

  it('rejects an upload owner other than production or editor registration', () => {
    expect(() => buildManuscriptUploadRequest('admin' as never, INPUT, OPTIONS))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT', detail: 'owner' }))
  })

  it('rejects a tag lookup for a category the workbench does not offer', () => {
    expect(() => buildManuscriptTagOptionsRequest('mood' as never))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT', detail: 'tag category' }))
  })

  it('rejects a creation tag returned under the wrong category', () => {
    const wrong = { ...OPTIONS, creationType: [{ ...OPTIONS.creationType[0]!, category: 'genre' as const }] }
    expect(() => buildManuscriptUploadRequest('produce', INPUT, wrong)).toThrow()
  })

  it.each([{ name: 'source.txt' }, { name: '../source.docx' }, { url: 'http://media.example/a.docx' },
    { url: 'https://user:secret@media.example/a.docx' }, { url: 'https://media.example/a.docx#part' },
    { objectKey: ' ' }])
  ('rejects an invalid uploaded document identity %j', (change) => {
    expect(() => buildManuscriptUploadRequest('produce', { ...INPUT, manuscriptFile: { ...INPUT.manuscriptFile, ...change } }, OPTIONS))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })

  it('keeps the two Word filenames and identities independent', () => {
    const body = buildManuscriptUploadRequest('produce', { ...INPUT,
      manuscriptFile: { ...INPUT.manuscriptFile, name: 'story.revision.2.DOCX' } }, OPTIONS).body
    expect(body).toMatchObject({ manuscriptFileName: 'story.revision.2.DOCX', manuscriptName: 'story.revision.2',
      originalFileName: '原小说.doc', originalNovelName: '原小说' })
  })

  it('starts manual production with the same manuscript binding and no implicit editor audit', () => {
    const project = { scriptName: '项目', createType: 1 as const, productionType: 0 as const,
      produceType: 1 as const, manuscriptId: 73, episodeCount: 80, scriptStyle: 0, storyboardCountPerEpisode: 0 }
    expect(buildManuscriptStartProduceRequest(73, project)).toEqual({ method: 'POST',
      path: '/script/center/pool/startProduce', body: { manuscriptId: 73, script: project } })
    expect(() => buildManuscriptStartProduceRequest(74, project)).toThrow()
    // @ts-expect-error Automatic parsing is excluded from the public creation input and rejected at runtime.
    expect(() => buildManuscriptStartProduceRequest(73, { ...project, createType: 2 })).toThrow()
    expect(() => buildManuscriptStartProduceRequest(73, { scriptName: '前贴', createType: 1, productionType: 0, produceType: 2 })).toThrow()
  })

})

describe('manuscript lookup requests and readers', () => {
  it('queries bindable manuscript IDs rather than AIGC project IDs without adding hidden pagination', () => {
    expect(buildBindableManuscriptsRequest({})).toEqual({ method: 'GET', path: '/script/center/pool/bindable' })
    expect(buildBindableManuscriptsRequest({ keyword: ' 故事 & 标题 ', pageNum: 2, pageSize: 20 }))
      .toEqual({ method: 'GET', path: '/script/center/pool/bindable?keyword=%E6%95%85%E4%BA%8B+%26+%E6%A0%87%E9%A2%98&pageNum=2&pageSize=20' })
    expect(() => buildBindableManuscriptsRequest({ pageNum: 0 })).toThrow()
  })

  it('reads the selector rows while preserving the provider total and manuscript identity', () => {
    const rows = [{ id: 73, scriptName: '故事', episodeCount: '80', status: 'claimed', custom: true }]
    expect(readBindableManuscripts({ rows, total: 100 })).toEqual({ total: 100,
      rows: [{ manuscript_id: 73, name: '故事', episode_count: 80, status: 'claimed', snapshot: rows[0] }] })
    expect(readBindableManuscripts({ rows: [] })).toEqual({ total: null, rows: [] })
  })

  it.each([null, [], {}, { rows: 'bad' }, { rows: [{ scriptName: '无ID' }] }, { rows: [], total: 'bad' }])
  ('rejects an unreadable bindable page %j', (data) => {
    expect(() => readBindableManuscripts(data)).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })

  it('addresses only the selected manuscript detail and bound-file lookup', () => {
    expect(buildManuscriptDetailRequest(73)).toEqual({ method: 'GET', path: '/script/center/pool/detail/73' })
    expect(buildManuscriptFileRequest(73)).toEqual({ method: 'GET', path: '/script/center/pool/manuscriptFile/73' })
    expect(() => buildManuscriptDetailRequest(0)).toThrow()
    expect(() => buildManuscriptFileRequest(1.2)).toThrow()
  })

  it('reads real detail, declarations, permission flags and both document identities', () => {
    const data = { manuscript: { id: 73, scriptName: '故事', episodeCount: 80, status: 'claimed',
      manuscriptType: 2, versionNo: 3, scriptFormat: 4, producerType: 1, creationType: '10',
      sourceScriptName: '', genreTagIds: '20,21', eraTagIds: '30', audienceTagIds: '40',
      hasCopyright: '1', copyrightOwner: '用户声明的版权方' }, holderPostCode: 'prodlead',
    canModify: true, canDistribute: 1, canClaim: false, canFinishProduce: 0,
    manuscriptFileName: '剧本.docx', manuscriptFileUrl: 'https://media.example/manuscript.docx', manuscriptObjectKey: 'prod/docs/a.docx',
    originalFileName: '原文.doc', originalFileUrl: 'https://media.example/original.doc', originalObjectKey: 'prod/docs/b.doc' }
    const detail = readManuscriptDetail(data)
    expect(detail).toMatchObject({ manuscript_id: 73, name: '故事', episode_count: 80, status: 'claimed',
      manuscript_type: 2, version_no: 3, script_format: 4, producer_type: 1, creation_type: '10',
      has_copyright: '1', copyright_owner: '用户声明的版权方', can_modify: true, can_distribute: true,
      can_claim: false, holder_post_code: 'prodlead',
      manuscript_file: { file_name: '剧本.docx', file_url: 'https://media.example/manuscript.docx', object_key: 'prod/docs/a.docx' },
      original_file: { file_name: '原文.doc', file_url: 'https://media.example/original.doc', object_key: 'prod/docs/b.doc' } })
    expect(detail.snapshot).toEqual(data)
    expect(detail.snapshot).not.toBe(data)
    expect(detail.snapshot.manuscript).not.toBe(data.manuscript)
  })

  it('keeps absent permission and copyright evidence unknown instead of copying frontend defaults', () => {
    expect(readManuscriptDetail({ manuscript: { id: 73 } })).toMatchObject({ manuscript_id: 73,
      has_copyright: null, copyright_owner: null, can_modify: null, can_distribute: null,
      manuscript_file: { file_name: null, file_url: null, object_key: null } })
  })

  it('reads numeric 0 permission flags as false and other numbers as unknown', () => {
    expect(readManuscriptDetail({ manuscript: { id: 73 }, canModify: 0, canDistribute: 1, canClaim: 2 }))
      .toMatchObject({ can_modify: false, can_distribute: true, can_claim: null })
  })

  it.each([null, {}, { id: 73 }, { manuscript: {} }, { manuscript: { id: 0 } }])
  ('rejects a detail payload without the current manuscript identity %j', (data) => {
    expect(() => readManuscriptDetail(data)).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })

  it('reads bound-file metadata without inventing an upload ID or a file when it is absent', () => {
    const data = { manuscriptFileName: '剧本.docx', manuscriptFileUrl: 'https://media.example/a.docx', manuscriptObjectKey: 'prod/a.docx' }
    expect(readManuscriptFile(data)).toEqual({ file_name: '剧本.docx', file_url: 'https://media.example/a.docx',
      object_key: 'prod/a.docx', snapshot: data })
    expect(readManuscriptFile({})).toEqual({ file_name: null, file_url: null, object_key: null, snapshot: {} })
    expect(() => readManuscriptFile(null)).toThrow()
  })
})

import { describe, expect, it } from 'vitest'
import { buildManuscriptProjectCheckRequest, buildProjectCreateRequest, readCreatedProjectId, readManuscriptProjectCheck, readProjectDetail,
  type ProjectCreateInput } from '../src/project.ts'

const CREATE: ProjectCreateInput = {
  scriptName: '第一个项目', createType: 1, productionType: 0, produceType: 1,
  manuscriptId: 42, scriptStyle: 0, episodeCount: 10, storyboardCountPerEpisode: 0,
  globalConfig: { standardId: 31, modelId: 'selected-current-model', duration: 5, backupModelList: [] },
}

const PROJECT = {
  id: 73, scriptName: '原名', createType: 2, productionType: 0, produceType: 1, manuscriptId: 42,
  parsingStatus: 5, parsingMsg: '',
  globalConfig: '{"standardId":31,"scriptUrl":"https://media.example/source.docx"}',
  episodeCount: 10, extraProviderField: { retained: true },
}

describe('buildProjectCreateRequest', () => {
  it('encodes settings once and binds a content project to the selected manuscript', () => {
    const body = buildProjectCreateRequest(CREATE)
    expect(body).toEqual({ ...CREATE, globalConfig: JSON.stringify(CREATE.globalConfig) })
    expect(CREATE.globalConfig).toEqual({ standardId: 31, modelId: 'selected-current-model', duration: 5, backupModelList: [] })
    expect(body).not.toHaveProperty('id')
  })

  it('keeps a selected pre-roll material project separate from manuscript content', () => {
    expect(buildProjectCreateRequest({ scriptName: '前贴素材', createType: 1, productionType: 0, produceType: 2 }))
      .toEqual({ scriptName: '前贴素材', createType: 1, productionType: 0, produceType: 2, manuscriptId: null })
  })

  it('keeps canvas mode explicit and does not add storyboard counts or model defaults', () => {
    expect(buildProjectCreateRequest({ scriptName: '画布项目', createType: 1, productionType: 1,
      produceType: 1, manuscriptId: 42 })).toEqual({ scriptName: '画布项目', createType: 1,
      productionType: 1, produceType: 1, manuscriptId: 42 })
  })

  it('rejects an unbound content project instead of converting it to pre-roll', () => {
    expect(() => buildProjectCreateRequest({ ...CREATE, manuscriptId: 0 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    // @ts-expect-error An unbound manuscript is also excluded from the public input type.
    expect(() => buildProjectCreateRequest({ scriptName: '未绑定', createType: 1, productionType: 0, produceType: 1 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })

  it('rejects missing production-content selection rather than defaulting to material mode', () => {
    // @ts-expect-error The caller must select a production-content type explicitly.
    expect(() => buildProjectCreateRequest({ scriptName: '未选择', createType: 1, productionType: 0 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })

  it.each([{ scriptName: ' ' }, { manuscriptId: -1 }, { episodeCount: -1 },
    { storyboardCountPerEpisode: 1.2 }, { scriptStyle: Number.NaN }])
  ('rejects unusable project values %j', (change) => {
    expect(() => buildProjectCreateRequest({ ...CREATE, ...change }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })

  it('refuses AI parsing creation outside the manual-project scope', () => {
    // @ts-expect-error AI parsing is outside the manual creation API.
    expect(() => buildProjectCreateRequest({ ...CREATE, createType: 2 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })

  it('refuses cyclic settings instead of producing a partial serialized configuration', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => buildProjectCreateRequest({ ...CREATE, globalConfig: cyclic })).toThrow()
  })
})

describe('project reads', () => {
  it('checks duplicate projects by manuscript and workspace mode', () => {
    expect(buildManuscriptProjectCheckRequest(42, 1)).toEqual({ method: 'GET',
      path: '/aigc/script/checkManuscriptProject?manuscriptId=42&productionType=1' })
    expect(() => buildManuscriptProjectCheckRequest(0, 0)).toThrow()
    // @ts-expect-error Invalid modes must also fail at the wire boundary.
    expect(() => buildManuscriptProjectCheckRequest(42, 2)).toThrow()
  })

  it.each([0, 1, '0', '2'])('reads a duplicate-project count %s', (value) => {
    expect(readManuscriptProjectCheck(value)).toBe(Number(value))
  })

  it.each([null, {}, -1, 0.5, '', 'unknown'])('rejects an unknown duplicate-project count %j', (value) => {
    expect(() => readManuscriptProjectCheck(value)).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })
  it.each([73, '73'])('reads a scalar project creation receipt %s', (data) => {
    expect(readCreatedProjectId(data)).toBe(73)
  })

  it.each([null, 0, -1, 1.2, {}, { id: 73 }, '73x'])('rejects an unproven creation identity %j', (data) => {
    expect(() => readCreatedProjectId(data)).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })

  it('reads parsing state and settings while keeping a detached provider record', () => {
    const detail = readProjectDetail(PROJECT)
    expect(detail).toMatchObject({ script_id: 73, name: '原名', production_type: 0,
      create_type: 2, produce_type: 1, manuscript_id: 42,
      parsing_status: 5, parsing_phase: 'ready', parsing_message: '',
      project_settings: { globalConfig: { standardId: 31, scriptUrl: 'https://media.example/source.docx' } } })
    expect(detail.snapshot).toEqual(PROJECT)
    expect(detail.snapshot).not.toBe(PROJECT)
    expect(detail.snapshot.extraProviderField).not.toBe(PROJECT.extraProviderField)
  })

  it.each([[0, 'pending'], [1, 'pending'], [2, 'pending'], [3, 'failed'], [4, 'failed'],
    [5, 'ready'], [6, 'ready'], [7, 'failed'], [8, 'failed'], [99, 'unknown']] as const)
  ('preserves raw status %s and the workbench phase %s', (status, phase) => {
    expect(readProjectDetail({ ...PROJECT, parsingStatus: status })).toMatchObject({ parsing_status: status, parsing_phase: phase })
  })

  it('keeps absent parsing evidence unknown rather than announcing completion', () => {
    expect(readProjectDetail({ id: 73 })).toMatchObject({ parsing_status: null, parsing_phase: 'unknown',
      parsing_message: null, manuscript_id: null, create_type: null })
  })

  it.each([null, [], { scriptName: 'no id' }, { id: 0 }, { id: 73, manuscriptId: -1 }])
  ('rejects unreadable project identity %j', (data) => {
    expect(() => readProjectDetail(data)).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })
})

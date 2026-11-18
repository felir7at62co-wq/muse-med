/** Native paths and catalog cursor identities in creation fixtures' printed PTC results. */
import type { WorkingBudgetOracleInput } from '../working-budget-oracle.ts'

/** Creation recordings whose PTC JSON contains paths returned by native tools. */
export type CreationBudgetOwner = 'muse-creation-ptc' | 'muse-creation-review-guidance' | 'muse-creation-stage-diagnostics'
  | 'muse-skill-market-bounded-catalog-ptc' | 'muse-skill-market-creation-binding-ptc' | 'muse-video-screenplay-entry-creation'

interface PathField {
  readonly keys: readonly string[]
  readonly segments: readonly string[]
  readonly prefix: string
  readonly suffix: string
}

interface ResultPaths {
  readonly callId: string
  readonly fields: readonly PathField[]
}

const PATHS: Readonly<Record<CreationBudgetOwner, readonly ResultPaths[]>> = {
  'muse-creation-ptc': [{ callId: 'call_creation_skill', fields: [
    { keys: ['resourceBase', 'path'], segments: ['.dsh', 'skills', 'audio-transcribe'], prefix: '', suffix: '' },
  ] }],
  'muse-creation-review-guidance': [
    { callId: 'call_creation_skill', fields: [
      { keys: ['skill', 'resourceBase', 'path'], segments: ['.dsh', 'skills', 'screenplay-project'], prefix: '', suffix: '' },
    ] },
    { callId: 'call_creation_workflow', fields: [
      { keys: ['resourceBase', 'path'], segments: ['.dsh', 'skills', 'video-review'], prefix: '', suffix: '' },
    ] },
    { callId: 'call_creation_format', fields: [
      { keys: ['skill', 'resourceBase', 'path'], segments: ['.dsh', 'skills', 'screenplay-format'], prefix: '', suffix: '' },
    ] },
    { callId: 'call_creation_quality', fields: [
      { keys: ['writing', 'path'], segments: ['.dsh', 'skills', 'screenplay-format', 'references', 'writing-quality.md'], prefix: '', suffix: '' },
      { keys: ['wiki', 'resourceBase', 'path'], segments: ['.dsh', 'skills', 'muse-llm-wiki'], prefix: '', suffix: '' },
    ] },
  ],
  'muse-creation-stage-diagnostics': [{ callId: 'call_creation_skill', fields: [
    { keys: ['failure'], segments: ['missing-scene.json'], prefix: 'scene_file_missing: 场次 JSON 文件不可用：', suffix: '' },
    { keys: ['schema_failure'], segments: ['invalid-scene.json'], prefix: 'scene_file_invalid: 场次文件 ',
      suffix: ' 不符合完整场次字段要求：\nbeats.0.requires_knowledge: Invalid input: expected array, received undefined\nbeats.0.witnesses: Invalid input: expected array, received undefined' },
  ] }],
  'muse-skill-market-bounded-catalog-ptc': [{ callId: 'call_bounded_ptc_load', fields: [
    { keys: ['resourceBase', 'path'], segments: ['.dsh', 'bounded-market', 'packages',
      'a2346e1c0efd03f2719a84f6b57376e748f7014cc128ae5631e486d032aaac1c', 'skills', 'market-scene-14'], prefix: '', suffix: '' },
  ] }],
  'muse-skill-market-creation-binding-ptc': ['call_creation_skill_old_1', 'call_creation_skill_old_2'].map(callId => ({ callId, fields: [
    { keys: ['resourceBase', 'path'], segments: ['.dsh', 'market-creation', 'packages',
      '36c57f2b809312cd6b4c2f9e4fe9ab7cd98daebb1b1f55ead14e9d1158bbd5d5', 'skills', 'version-bound-review'], prefix: '', suffix: '' },
  ] })),
  'muse-video-screenplay-entry-creation': [{ callId: 'call_creation_skill', fields: [
    { keys: ['resourceBase', 'path'], segments: ['.dsh', 'product-video-skills', 'video-to-screenplay'], prefix: '', suffix: '' },
  ] }],
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Creation budget input requires an object')
  }
  return value as Record<string, unknown>
}

function fieldValue(value: unknown, keys: readonly string[]): unknown {
  for (const key of keys) value = object(value)[key]
  return value
}

function oneRow(rows: readonly Record<string, unknown>[], type: string, matches: (data: Record<string, unknown>) => boolean): Record<string, unknown> {
  const selected = rows.filter(row => row.type === type && matches(object(row.data)))
  if (selected.length !== 1) throw new Error(`Creation budget requires exactly one ${type} for its declared call`)
  return object(selected[0]?.data)
}

function printedResult(rows: readonly Record<string, unknown>[], callId: string): { block: Record<string, unknown>; text: string; printed: unknown } {
  const call = oneRow(rows, 'tool/call', data => data.callId === callId)
  if (call.name !== 'run_code') throw new Error(`Creation budget call ${callId} must use run_code`)
  const result = oneRow(rows, 'tool/result', data => object(data.message).toolCallId === callId)
  const message = object(result.message)
  if (message.isError !== false || !Array.isArray(message.content) || message.content.length !== 1) {
    throw new Error(`Creation budget call ${callId} must have one successful result block`)
  }
  const block = object(message.content[0])
  if (block.type !== 'text' || typeof block.text !== 'string') throw new Error('Creation budget result must be text')
  return { block, text: block.text, printed: JSON.parse(block.text) }
}

/**
 * Expand only the declared paths and catalog cursor identities before pricing printed JSON.
 * The source writer remains canonical; the shared oracle receives the native
 * spelling and its JSON escaping without changes to other text or spacing.
 * @param owner - Recording owning these path fields.
 * @param input - Independent expected writer, sidecars and replay directory.
 * @param nativePath - The replay host's path join operation.
 * @param sessionId - Independently allocated replay Session identity for catalog cursors.
 * @returns A detached budget input with only declared result strings expanded.
 * @throws When a declared call, result, field or exact path differs from the fixture.
 */
export function creationBudgetInput(
  owner: CreationBudgetOwner,
  input: WorkingBudgetOracleInput,
  nativePath: { join(...segments: string[]): string },
  sessionId?: string,
): WorkingBudgetOracleInput {
  const rows = input.log.split('\n').filter(line => line.trim() !== '').map(line => object(JSON.parse(line)))
  for (const { callId, fields } of PATHS[owner]) {
    const result = printedResult(rows, callId)
    let text = result.text
    for (const field of fields) {
      const expected = field.prefix + ['{{cwd}}', ...field.segments].join('/') + field.suffix
      if (fieldValue(result.printed, field.keys) !== expected) {
        throw new Error(`Creation budget call ${callId} has an unexpected ${field.keys.join('.')} path`)
      }
      const literal = JSON.stringify(expected)
      if (text.split(literal).length !== 2) throw new Error('Creation budget path must have one exact JSON spelling')
      text = text.replace(literal, JSON.stringify(field.prefix + nativePath.join(input.cwd, ...field.segments) + field.suffix))
    }
    result.block.text = text
  }
  if (owner === 'muse-skill-market-bounded-catalog-ptc') {
    if (sessionId === undefined || sessionId.length === 0) throw new Error('Catalog budget requires the replay Session identity')
    const result = printedResult(rows, 'call_bounded_ptc_catalog')
    const pages = object(result.printed).pages
    if (!Array.isArray(pages) || pages.length !== 8) throw new Error('Catalog budget requires eight declared pages')
    for (const page of pages.slice(0, 7)) {
      if (object(object(page).nextCursor).sessionId !== '{{session:1}}') throw new Error('Catalog budget cursor must identify the primary Session')
    }
    if (object(pages[7]).nextCursor !== undefined) throw new Error('Catalog budget final page must have no cursor')
    const literal = JSON.stringify('{{session:1}}')
    if (result.text.split(literal).length !== 8) throw new Error('Catalog budget requires seven exact cursor identity spellings')
    result.block.text = result.text.split(literal).join(JSON.stringify(sessionId))
  }
  return { ...input, log: rows.map(row => JSON.stringify(row)).join('\n') + '\n' }
}

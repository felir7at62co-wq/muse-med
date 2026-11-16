/** Native paths in the three creation fixtures' printed PTC results. */
import type { WorkingBudgetOracleInput } from '../working-budget-oracle.ts'

/** Creation recordings whose PTC JSON contains paths returned by native tools. */
export type CreationBudgetOwner = 'muse-creation-ptc' | 'muse-creation-review-guidance' | 'muse-creation-stage-diagnostics'

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

/**
 * Expand only the declared paths before pricing these fixtures' printed JSON.
 * The source writer remains canonical; the shared oracle receives the native
 * spelling and its JSON escaping without changes to other text or spacing.
 * @param owner - One of the three recordings owning these path fields.
 * @param input - Independent expected writer, sidecars and replay directory.
 * @param nativePath - The replay host's path join operation.
 * @returns A detached budget input with only declared result strings expanded.
 * @throws When a declared call, result, field or exact path differs from the fixture.
 */
export function creationBudgetInput(
  owner: CreationBudgetOwner,
  input: WorkingBudgetOracleInput,
  nativePath: { join(...segments: string[]): string },
): WorkingBudgetOracleInput {
  const rows = input.log.split('\n').filter(line => line.trim() !== '').map(line => object(JSON.parse(line)))
  for (const { callId, fields } of PATHS[owner]) {
    const call = oneRow(rows, 'tool/call', data => data.callId === callId)
    if (call.name !== 'run_code') throw new Error(`Creation budget call ${callId} must use run_code`)
    const result = oneRow(rows, 'tool/result', data => object(data.message).toolCallId === callId)
    const message = object(result.message)
    if (message.isError !== false || !Array.isArray(message.content) || message.content.length !== 1) {
      throw new Error(`Creation budget call ${callId} must have one successful result block`)
    }
    const block = object(message.content[0])
    if (block.type !== 'text' || typeof block.text !== 'string') throw new Error('Creation budget result must be text')
    let text = block.text
    const printed: unknown = JSON.parse(text)
    for (const field of fields) {
      const expected = field.prefix + ['{{cwd}}', ...field.segments].join('/') + field.suffix
      if (fieldValue(printed, field.keys) !== expected) {
        throw new Error(`Creation budget call ${callId} has an unexpected ${field.keys.join('.')} path`)
      }
      const literal = JSON.stringify(expected)
      if (text.split(literal).length !== 2) throw new Error('Creation budget path must have one exact JSON spelling')
      text = text.replace(literal, JSON.stringify(field.prefix + nativePath.join(input.cwd, ...field.segments) + field.suffix))
    }
    block.text = text
  }
  return { ...input, log: rows.map(row => JSON.stringify(row)).join('\n') + '\n' }
}

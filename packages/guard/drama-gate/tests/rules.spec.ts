import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { evaluateCall } from '@deepseek-ai/dsh-guard-drama'
import type { GateCall, GateDecision, GateReader } from '@deepseek-ai/dsh-guard-drama'
import {
  ALL_ON, MATCHED, PROJECT, PROJECT_CONFIG, PROJECT_CONFIG_TEXT, PROMPTS, RECONCILE, SCRIPT_ID, WORKSHOP, WORKSPACE,
  block, call, fakeReader, han, matchedJson, projectReader,
} from './harness.ts'

/**
 * Rule-level suite for the drama gate. Every case drives the pure evaluator with
 * a literal file map, so each rule's allow and deny side is pinned without a
 * registry, a real project, or a network call.
 */

/** The refusal reason, asserting the call was denied. */
function reason(decision: GateDecision): string {
  expect(decision.kind).toBe('deny')
  return decision.kind === 'deny' ? decision.reason : ''
}

/** One `jubian_*` write method plus the argument object that omits its key. */
const WRITES: [string, string, Record<string, unknown>][] = [
  ['jubian_model', 'apply', { script_id: 1, preview_path: 'model-settings.json' }],
  ['jubian_storyboard', 'create', {}],
  ['jubian_storyboard', 'save', {}],
  ['jubian_storyboard', 'generate', {}],
  ['jubian_storyboard', 'erase_subtitle', { task_id: 1, task_name: 't' }],
  ['jubian_video', 'image_generate', { asset_name: 'a', asset_type: 1, prompt: 'p' }],
  ['jubian_video', 'upscale', { task_id: 1, script_id: 2 }],
  ['jubian_asset', 'confirm_casting', { script_id: 1, material_id: 2 }],
  ['jubian_asset', 'remove', { script_id: 1, asset_id: 2 }],
]

describe('paid/write methods require an idempotency key', () => {
  it.each(WRITES)('denies %s.%s without a key', (toolName, method, extra) => {
    const decision = evaluateCall(call({ toolName, arguments: { method, ...extra } }))
    const text = reason(decision)
    expect(text).toContain(`${toolName}.${method} 是写/计费方法，必须带 idempotency_key`)
    expect(text).toContain('用同一个 key 再调一次，不要换 key 重发')
  })

  it.each(WRITES)('allows %s.%s once the key is present', (toolName, method, extra) => {
    // The two other paid rules are switched off so this case isolates the key
    // rule: `jubian_storyboard.generate` is otherwise also a paid submission, and
    // `jubian_video.image_generate` otherwise also needs project reconcile evidence.
    const decision = evaluateCall(call({
      toolName,
      arguments: { method, idempotency_key: 'k-1', ...extra },
      switches: { ...ALL_ON, officialAssets: false, reconcileFirst: false },
    }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('treats a blank key as absent', () => {
    const decision = evaluateCall(call({ toolName: 'jubian_storyboard', arguments: { method: 'save', idempotency_key: '   ' } }))
    expect(decision.kind).toBe('deny')
  })

  it('accepts a method written with surrounding whitespace and different case', () => {
    const decision = evaluateCall(call({
      toolName: 'jubian_storyboard',
      arguments: { method: ' Save ', idempotency_key: 'k' },
    }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('leaves read methods alone', () => {
    for (const method of ['get', 'list', 'materials', 'generated_image', 'task', 'tasks', 'subtasks']) {
      expect(evaluateCall(call({ toolName: 'jubian_video', arguments: { method } }))).toEqual({ kind: 'allow' })
    }
    expect(evaluateCall(call({ toolName: 'jubian_model', arguments: { method: 'preview' } })))
      .toEqual({ kind: 'allow' })
  })

  it('ignores a method argument on an unrelated tool', () => {
    expect(evaluateCall(call({ toolName: 'grep', arguments: { method: 'generate' } }))).toEqual({ kind: 'allow' })
  })

  it('ignores a non-string method', () => {
    expect(evaluateCall(call({ toolName: 'jubian_storyboard', arguments: { method: 7 } }))).toEqual({ kind: 'allow' })
  })

  it('honors the switch', () => {
    const decision = evaluateCall(call({
      toolName: 'jubian_storyboard',
      arguments: { method: 'save' },
      switches: { ...ALL_ON, idempotencyKey: false },
    }))
    expect(decision).toEqual({ kind: 'allow' })
  })
})

describe('shot-script content gate', () => {
  const validScript = `真人短剧写实风格\n${block(1, '2秒', '方恒：今天天气很好我们出门吧')}`

  /** A `write` of `text` into `path`, with everything else at its default. */
  function write(path: string, text: string, overrides: Partial<GateCall> = {}): GateDecision {
    return evaluateCall(call({
      toolName: 'write',
      arguments: { file_path: path, content: text },
      reader: fakeReader({ [path]: text }),
      ...overrides,
    }))
  }

  it('allows a valid director-format shot script', () => {
    expect(write(PROMPTS, validScript)).toEqual({ kind: 'allow' })
  })

  it('allows the 36-character ceiling exactly', () => {
    const script = `真人短剧写实风格\n${block(1, '4秒', `方恒：${han(36)}`)}`
    expect(write(PROMPTS, script)).toEqual({ kind: 'allow' })
  })

  it('allows an action shot with no dialogue whatever its duration', () => {
    const script = `真人短剧写实风格\n${['【镜头1】', '时长：4秒', '发声类型：action', '', '【镜头2】', '时长：1秒', '发声类型：action', ''].join('\n')}`
    expect(write(PROMPTS, script)).toEqual({ kind: 'allow' })
  })

  it('allows a non-director block that carries its own speaker field', () => {
    const script = [
      '真人短剧写实风格',
      '【镜头1】',
      '时长：2秒',
      '发声类型：dialogue',
      '说话人：方恒',
      `台词：${han(10)}`,
      '',
    ].join('\n')
    expect(write(PROMPTS, script)).toEqual({ kind: 'allow' })
  })

  it.each(['旁白', '画外音', '画外声', '心声', '（OS）', 'VO'])('allows the creative voice choice %s', (marker) => {
    const script = `真人短剧写实风格\n${block(1, '20秒', '方恒：你好')}\n${marker}：他走了\n`
    expect(write(PROMPTS, script)).toEqual({ kind: 'allow' })
  })

  it('does not read `voice_type` or `visual` as narration tokens', () => {
    const script = `真人短剧写实风格\n${block(1, '1秒', '方恒：你好')}`
    expect(write(PROMPTS, script)).toEqual({ kind: 'allow' })
  })

  it('allows long shots, long speech and deliberate pauses', () => {
    for (const [seconds, characters] of [['20秒', 45], ['1秒', 37], ['10秒', 2]] as const) {
      expect(write(PROMPTS, block(1, seconds, `方恒：${han(characters)}`))).toEqual({ kind: 'allow' })
    }
  })

  it.each(['0秒', '-1秒', '3.5秒', '', '很多秒'])('denies malformed explicit duration %s', (seconds) => {
    expect(reason(write(PROMPTS, block(1, seconds, '方恒：你好')))).toContain('正整数秒')
  })

  it('allows omitted duration for compiler estimation', () => {
    expect(write(PROMPTS, '【镜头1】\n发声类型：action\n')).toEqual({ kind: 'allow' })
  })

  it('counts only Han, letters, and digits', () => {
    const script = `真人短剧写实风格\n${block(1, '2秒', '方恒：你好，世界！abc 123')}`
    expect(write(PROMPTS, script)).toEqual({ kind: 'allow' })
  })

  it('gates the episode package copies as well as the prompts directory', () => {
    const path = join(PROJECT, 'episode_packages', '01', 'shot_script.txt')
    expect(write(path, `真人短剧写实风格\n${block(1, '0秒', '方恒：旁白说')}`).kind).toBe('deny')
  })

  it('leaves the archived source script alone', () => {
    const path = join(PROJECT, 'source', 'source_script.txt')
    expect(write(path, '旁白：这是一个原始剧本。\n')).toEqual({ kind: 'allow' })
  })

  it('leaves a text file outside the workshop pipeline directories alone', () => {
    expect(write(join(WORKSHOP, 'notes.txt'), '旁白：随便记一笔。\n')).toEqual({ kind: 'allow' })
    expect(write(join(WORKSPACE, 'todo.md'), '旁白：随便记一笔。\n')).toEqual({ kind: 'allow' })
    expect(write(join(PROJECT, 'source', 'raw.txt'), '旁白。')).toEqual({ kind: 'allow' })
  })

  it('ignores a non-string content argument', () => {
    const decision = evaluateCall(call({ toolName: 'write', arguments: { file_path: PROMPTS, content: 42 } }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('honors the switch', () => {
    const script = `真人短剧写实风格\n${block(1, '5秒', '方恒：旁白')}`
    expect(write(PROMPTS, script, { switches: { ...ALL_ON, shotScript: false } })).toEqual({ kind: 'allow' })
  })
})

describe('matched JSON content gate', () => {
  /** A `write` of `text` into a matched JSON path. */
  function write(path: string, text: string): GateDecision {
    return evaluateCall(call({ toolName: 'write', arguments: { file_path: path, content: text } }))
  }

  it('allows a consistent shot record', () => {
    expect(write(MATCHED, matchedJson({ script_duration: 2, text: han(10), visual: '真人短剧写实风格' }))).toEqual({ kind: 'allow' })
  })

  it('allows an action record with no dialogue', () => {
    expect(write(MATCHED, matchedJson({ script_duration: 3, text: '', voice_type: 'action' }))).toEqual({ kind: 'allow' })
  })

  it('reads the legacy `duration` field when script_duration is absent', () => {
    expect(write(MATCHED, matchedJson({ duration: 1, text: han(9) }))).toEqual({ kind: 'allow' })
  })

  it('allows long slow shots and voice choices without changing text', () => {
    expect(write(MATCHED, matchedJson({ script_duration: 20, text: han(45),
      voice_type: 'vo', visual: '（心声）他转身离开' }))).toEqual({ kind: 'allow' })
  })

  it.each([0, -1, 2.5, '3', null, undefined])('denies malformed duration %s', (duration) => {
    expect(reason(write(MATCHED, matchedJson({ script_duration: duration, text: han(9) })))).toContain('正整数秒')
  })

  it('rejects malformed JSON, missing shot arrays and malformed fields', () => {
    for (const text of ['{', '{ "version": 4 }', '{"shots":[null]}', matchedJson({ duration: 1, text: 42 })]) {
      expect(write(MATCHED, text).kind).toBe('deny')
    }
  })

  it('gates the episode package copy', () => {
    const path = join(PROJECT, 'episode_packages', '01', 'matched.json')
    expect(write(path, matchedJson({ script_duration: 0, text: '' })).kind).toBe('deny')
  })
})

describe('edit simulation', () => {
  const before = `真人短剧写实风格\n${block(1, '2秒', '方恒：今天天气很好我们出门吧')}`

  /** An `edit` replacing `oldString` with `newString` inside the stored script. */
  function edit(oldString: string, newString: string, replaceAll = false): GateDecision {
    return evaluateCall(call({
      toolName: 'edit',
      arguments: { file_path: PROMPTS, old_string: oldString, new_string: newString, replace_all: replaceAll },
      reader: fakeReader({ [PROMPTS]: before }),
    }))
  }

  it('allows an edit that keeps the file valid', () => {
    expect(edit('方恒：今天天气很好我们出门吧', '方恒：明天天气很好我们出门吧')).toEqual({ kind: 'allow' })
  })

  it('denies an edit that breaks the duration rule', () => {
    expect(reason(edit('时长：2秒', '时长：0秒'))).toContain('正整数秒')
  })

  it('allows narration edits', () => {
    expect(edit('主体状态追踪：在场', '主体状态追踪：在场\n旁白：他走了')).toEqual({ kind: 'allow' })
  })

  it('replaces every occurrence with replace_all', () => {
    const decision = evaluateCall(call({
      toolName: 'edit',
      arguments: { file_path: PROMPTS, old_string: '时长：2秒', new_string: '时长：1秒', replace_all: true },
      reader: fakeReader({
        [PROMPTS]: `真人短剧写实风格\n${block(1, '2秒', '方恒：今天天气很好我们出门吧')}${block(2, '2秒', '方恒：今天天气很好我们出门吧')}`,
      }),
    }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('treats `$&` in the new text literally, as the edit tool does', () => {
    expect(reason(edit('2秒', '$&'))).toContain('时长「$&」不合法')
  })

  it('leaves an edit the tool itself would refuse to the tool', () => {
    // No match at all, and an ambiguous match without replace_all: neither writes a file.
    expect(edit('不存在的文本', '旁白：x')).toEqual({ kind: 'allow' })
    const ambiguous = `真人短剧写实风格\n${block(1, '2秒', '方恒：今天天气很好我们出门吧')}${block(2, '2秒', '方恒：今天天气很好我们出门吧')}`
    const decision = evaluateCall(call({
      toolName: 'edit',
      arguments: { file_path: PROMPTS, old_string: '时长：2秒', new_string: '时长：5秒' },
      reader: fakeReader({ [PROMPTS]: ambiguous }),
    }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('leaves an unreadable target to the tool', () => {
    const decision = evaluateCall(call({
      toolName: 'edit',
      arguments: { file_path: PROMPTS, old_string: 'a', new_string: '旁白：b' },
      reader: fakeReader(),
    }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('ignores a missing or empty old_string', () => {
    for (const args of [
      { file_path: PROMPTS, old_string: '', new_string: '旁白：b' },
      { file_path: PROMPTS, new_string: '旁白：b' },
      { file_path: PROMPTS, old_string: 1, new_string: 'x' },
    ]) {
      expect(evaluateCall(call({ toolName: 'edit', arguments: args, reader: fakeReader({ [PROMPTS]: before }) })))
        .toEqual({ kind: 'allow' })
    }
  })

  it('ignores an edit with no file_path', () => {
    expect(evaluateCall(call({ toolName: 'edit', arguments: { old_string: 'a', new_string: '旁白' } })))
      .toEqual({ kind: 'allow' })
    expect(evaluateCall(call({ toolName: 'edit', arguments: { file_path: '   ', old_string: 'a', new_string: 'b' } })))
      .toEqual({ kind: 'allow' })
  })

  it('resolves a relative file_path against the session cwd', () => {
    const relativeEdit = evaluateCall(call({
      toolName: 'edit',
      arguments: { file_path: 'short-drama/demo-drama/prompts/01.txt', old_string: '2秒', new_string: '0秒' },
      reader: fakeReader({ [PROMPTS]: before }),
    }))
    expect(reason(relativeEdit)).toContain('正整数秒')
  })
})

describe('official assets before a paid submission', () => {
  const manifest = (official: boolean): string => JSON.stringify({ assets: [{ name: '方恒', official }] })
  const MANIFEST = join(PROJECT, 'assets_manifest.json')
  const STATE = join(PROJECT, 'pipeline_state.json')

  /** A `jubian_storyboard.generate` call that names its project, with a valid key. */
  function submit(overrides: Partial<GateCall> = {}, files: Readonly<Record<string, string>> = {}): GateDecision {
    return evaluateCall(call({
      toolName: 'jubian_storyboard',
      arguments: {
        method: 'generate', idempotency_key: 'k', content_duration_ms: 12000, storyboard_id: 1, script_id: SCRIPT_ID,
      },
      reader: projectReader(files),
      ...overrides,
    }))
  }

  it("denies when the call's own project holds no official asset record", () => {
    const text = reason(submit())
    expect(text).toContain('jubian_storyboard.generate 会真实计费，但这个项目里找不到 official=true 的正式资产记录')
    expect(text).toContain('先走资产三阶段门禁')
  })

  it('denies when the manifest exists but lists no official asset', () => {
    expect(submit({}, { [MANIFEST]: manifest(false) }).kind).toBe('deny')
  })

  it("does not read a manifest from another project's directory", () => {
    // Only the project the call names carries evidence; a sibling's manifest is
    // not evidence for this submission, which is the whole point of the binding.
    const sibling = join(WORKSHOP, 'other-drama')
    const reader = fakeReader(
      { [PROJECT_CONFIG]: PROJECT_CONFIG_TEXT, [join(sibling, 'assets_manifest.json')]: manifest(true) },
      { [WORKSHOP]: ['demo-drama', 'other-drama'] },
    )
    expect(reason(submit({ reader }))).toContain('找不到 official=true 的正式资产记录')
  })

  it('does not read a manifest from the workshop root', () => {
    const reader = projectReader({ [join(WORKSHOP, 'assets_manifest.json')]: manifest(true) })
    expect(reason(submit({ reader }))).toContain('找不到 official=true')
  })

  it('allows a manifest in the project the call names', () => {
    expect(submit({}, { [MANIFEST]: manifest(true) })).toEqual({ kind: 'allow' })
  })

  it('binds a call that names the project by project_dir instead of script_id', () => {
    const decision = evaluateCall(call({
      toolName: 'jubian_storyboard',
      arguments: { method: 'generate', idempotency_key: 'k', project_dir: PROJECT },
      reader: projectReader({ [MANIFEST]: manifest(true) }),
    }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('allows a bare array manifest', () => {
    expect(submit({}, { [MANIFEST]: JSON.stringify([{ official: true }]) })).toEqual({ kind: 'allow' })
  })

  it('allows a manifest whose assets are keyed by id', () => {
    const assets = { assets: { fang: { official: true } } }
    expect(submit({}, { [MANIFEST]: JSON.stringify(assets) })).toEqual({ kind: 'allow' })
  })

  it('falls back to a completed official_assets stage when no manifest exists', () => {
    const state = JSON.stringify({ version: 3, stages: { official_assets: { status: 'completed' } } })
    expect(submit({}, { [STATE]: state })).toEqual({ kind: 'allow' })
  })

  it('accepts a per-episode official_assets completion', () => {
    const state = JSON.stringify({ version: 3, stages: {}, episodes: { '01': { official_assets: { status: 'completed' } } } })
    expect(submit({}, { [STATE]: state })).toEqual({ kind: 'allow' })
  })

  it('does not accept a merely running official_assets stage', () => {
    const state = JSON.stringify({ stages: { official_assets: { status: 'running' } } })
    expect(submit({}, { [STATE]: state }).kind).toBe('deny')
  })

  it('ignores unreadable or malformed evidence', () => {
    expect(submit({}, { [MANIFEST]: '{ not json' }).kind).toBe('deny')
  })

  it('reads an injected projectRoot instead of resolving the call arguments', () => {
    const explicit = join(WORKSPACE, 'elsewhere')
    const reader = fakeReader({ [join(explicit, 'assets_manifest.json')]: manifest(true) })
    expect(submit({ reader, projectRoot: explicit })).toEqual({ kind: 'allow' })
  })

  it('denies a paid submission the gate cannot bind to a project', () => {
    const text = reason(submit({ arguments: { method: 'generate', idempotency_key: 'k', storyboard_id: 1 } }))
    expect(text).toContain('门禁无法核对它引用的资产')
    expect(text).toContain('请在调用里给出 project_dir（项目根目录）或 script_id（剧变项目 ID）')
  })

  it('denies a script_id that matches no project of the workshop', () => {
    const text = reason(submit({ arguments: { method: 'generate', idempotency_key: 'k', script_id: 9999 } }))
    expect(text).toContain('门禁无法核对它引用的资产')
  })

  it('does not block asset generation, which runs before any official asset exists', () => {
    // The reconcile rule is the one that guards asset generation, so it is
    // switched off here to isolate this rule.
    const decision = evaluateCall(call({
      toolName: 'jubian_video',
      arguments: { method: 'image_generate', asset_name: 'a', asset_type: 1, prompt: 'p', idempotency_key: 'k' },
      switches: { ...ALL_ON, reconcileFirst: false },
    }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('does not block a storyboard read method', () => {
    expect(submit({ arguments: { method: 'get', storyboard_id: 1 } })).toEqual({ kind: 'allow' })
  })

  it('refuses to guess a project when no workspace root can be resolved', () => {
    // Without one, neither `project_dir` nor a search by `script_id` has a base
    // directory, so the call cannot be placed and the gate says so rather than
    // allowing it on the assumption that some project somewhere would qualify.
    const text = reason(submit({ sessionCwd: undefined, configuredRoot: undefined }))
    expect(text).toContain('找不到工作目录')
    expect(text).toContain('门禁无法核对它引用的资产')
  })

  it('falls back to the configured root when the session states no cwd', () => {
    expect(submit({ sessionCwd: undefined, configuredRoot: WORKSPACE }, { [MANIFEST]: manifest(true) }))
      .toEqual({ kind: 'allow' })
  })

  it('falls through a relative session cwd to the configured root', () => {
    const reader = projectReader({ [MANIFEST]: manifest(true) })
    expect(submit({ sessionCwd: 'relative/path', configuredRoot: WORKSPACE, reader })).toEqual({ kind: 'allow' })
    expect(submit({ sessionCwd: 'relative/path', configuredRoot: WORKSPACE, reader: projectReader() }).kind).toBe('deny')
    expect(submit({ sessionCwd: '   ', configuredRoot: WORKSPACE, reader: projectReader() }).kind).toBe('deny')
  })

  it('honors the switch', () => {
    expect(submit({ switches: { ...ALL_ON, officialAssets: false } })).toEqual({ kind: 'allow' })
  })
})

describe('a project reconcile before creating a paid asset', () => {
  /** One reconcile report as the pipeline's tool writes it, `minutesAgo` minutes old. */
  function report(overrides: Record<string, unknown> = {}, minutesAgo = 0): Record<string, unknown> {
    return {
      script_id: SCRIPT_ID,
      ran_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      unregistered: [],
      dangling: [],
      disposition: {},
      blocking: [],
      ignored_without_note: [],
      ready: true,
      policy: {},
      ...overrides,
    }
  }

  /** The reader of a workshop whose only project is {@link PROJECT}, holding that evidence text. */
  function withEvidence(content: string): GateReader {
    return projectReader({ [RECONCILE]: content })
  }

  /** A `jubian_video.image_generate` call carrying a key and its project, as the pipeline sends it. */
  function generate(overrides: Partial<GateCall> = {}): GateDecision {
    return evaluateCall(call({
      toolName: 'jubian_video',
      arguments: {
        method: 'image_generate', asset_name: 'a', asset_type: 1, prompt: 'p', idempotency_key: 'k', script_id: SCRIPT_ID,
      },
      reader: projectReader(),
      ...overrides,
    }))
  }

  it('denies when no reconcile evidence exists', () => {
    const text = reason(generate())
    expect(text).toContain('jubian_video.image_generate 会新建资产并真实计费')
    expect(text).toContain('没有 _probe/asset-reconcile.json')
    expect(text).toContain('python _tools/asset_reconcile.py')
    expect(text).toContain('--dispose <asset_id> --status ignored --note')
  })

  it('denies evidence that is not parseable JSON', () => {
    expect(reason(generate({ reader: withEvidence('{ not json') }))).toContain('不是可解析的对账 JSON')
  })

  it('denies evidence that is JSON but not a report object', () => {
    expect(reason(generate({ reader: withEvidence('[1, 2]') }))).toContain('不是可解析的对账 JSON')
  })

  const BAD_TIMESTAMPS: [string, Record<string, unknown>][] = [
    ['missing', { ran_at: undefined }],
    ['not a string', { ran_at: 42 }],
    ['not a time', { ran_at: '昨天下午' }],
  ]

  it.each(BAD_TIMESTAMPS)('denies a ran_at that is %s', (_label, overrides) => {
    expect(reason(generate({ reader: withEvidence(JSON.stringify(report(overrides))) })))
      .toContain('ran_at 缺失或不是 ISO 时间')
  })

  it('denies evidence older than 24 hours', () => {
    const text = reason(generate({ reader: withEvidence(JSON.stringify(report({}, 25 * 60))) }))
    expect(text).toContain('对账已过期')
    expect(text).toContain('超过 24 小时')
  })

  it('denies evidence more than five minutes ahead of the clock', () => {
    expect(reason(generate({ reader: withEvidence(JSON.stringify(report({}, -10))) }))).toContain('对账时间在未来')
  })

  it('accepts evidence a minute ahead of the clock', () => {
    expect(generate({ reader: withEvidence(JSON.stringify(report({}, -1))) })).toEqual({ kind: 'allow' })
  })

  it('reads a timestamp with no zone as China Standard Time', () => {
    // The pipeline's tool may write a naive stamp; it means +08:00 wherever the
    // gate runs, so the verdict cannot depend on the host's own zone.
    const cn = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19)
    expect(generate({ reader: withEvidence(JSON.stringify(report({ ran_at: cn }))) })).toEqual({ kind: 'allow' })
    const ahead = new Date(Date.now() + (8 * 60 + 10) * 60 * 1000).toISOString().slice(0, 19)
    expect(reason(generate({ reader: withEvidence(JSON.stringify(report({ ran_at: ahead }))) }))).toContain('对账时间在未来')
  })

  it('denies a remote asset that is selected but still undisposed', () => {
    const text = reason(generate({ reader: withEvidence(JSON.stringify(report({ blocking: [83840], ready: false }))) }))
    expect(text).toContain('对账里还有 1 条未处置的未登记资产：83840')
  })

  it('denies an asset ignored without a note', () => {
    const text = reason(generate({ reader: withEvidence(JSON.stringify(report({ ignored_without_note: [83840], ready: false }))) }))
    expect(text).toContain('有 1 条判为 ignored 但没写 note：83840')
  })

  it('denies a report that is not marked ready', () => {
    expect(reason(generate({ reader: withEvidence(JSON.stringify(report({ ready: false }))) }))).toContain('对账未标记 ready')
  })

  it('allows fresh evidence whose unregistered assets are all disposed', () => {
    const disposed = report({
      unregistered: [{ asset_id: 83840, name: '陆沉舟｜深巧克力年轻高定西装' }],
      disposition: { 83840: { status: 'registered', note: '' } },
    })
    expect(generate({ reader: withEvidence(JSON.stringify(disposed)) })).toEqual({ kind: 'allow' })
  })

  it('allows a minimal ready report carrying no disposition fields at all', () => {
    expect(generate({ reader: withEvidence(JSON.stringify({ ran_at: report()['ran_at'], ready: true })) }))
      .toEqual({ kind: 'allow' })
  })

  it('reads the evidence below an explicitly configured project root', () => {
    const explicit = join(WORKSPACE, 'elsewhere')
    const reader = fakeReader({ [join(explicit, '_probe', 'asset-reconcile.json')]: JSON.stringify(report()) })
    expect(generate({ reader, projectRoot: explicit })).toEqual({ kind: 'allow' })
  })

  it("does not accept a sibling project's evidence", () => {
    // The evidence is per project: a sibling's fresh reconcile says nothing about
    // what this project's remote side already contains, so it cannot authorize
    // creating an asset here.
    const sibling = join(WORKSHOP, 'other-drama')
    const reader = fakeReader(
      { [PROJECT_CONFIG]: PROJECT_CONFIG_TEXT, [join(sibling, '_probe', 'asset-reconcile.json')]: JSON.stringify(report()) },
      { [WORKSHOP]: ['demo-drama', 'other-drama'] },
    )
    expect(reason(generate({ reader }))).toContain('没有 _probe/asset-reconcile.json')
  })

  it('names exactly the one project it judged', () => {
    const text = reason(generate({ reader: withEvidence(JSON.stringify(report({}, 25 * 60))) }))
    expect(text).toContain('对账已过期')
    expect(text.match(/已查：/g)).toHaveLength(1)
    expect(text).toContain(`已查：${PROJECT}`)
  })

  it('denies an asset creation the gate cannot bind to a project', () => {
    const text = reason(generate({ arguments: { method: 'image_generate', idempotency_key: 'k' } }))
    expect(text).toContain('这次调用没有说明它属于哪个项目')
    expect(text).toContain('请在调用里给出 project_dir（项目根目录）或 script_id（剧变项目 ID）')
  })

  it('leaves a read method alone', () => {
    for (const method of ['asset', 'assets', 'get', 'list', 'subtasks']) {
      expect(evaluateCall(call({ toolName: 'jubian_video', arguments: { method } }))).toEqual({ kind: 'allow' })
    }
  })

  it('leaves every other paid method alone', () => {
    // The official-asset rule is the one that judges those submissions, so it is
    // switched off here to isolate this rule.
    const switches = { ...ALL_ON, officialAssets: false }
    expect(evaluateCall(call({
      toolName: 'jubian_storyboard',
      arguments: { method: 'generate', idempotency_key: 'k' },
      switches,
    }))).toEqual({ kind: 'allow' })
    const OTHERS: [string, Record<string, unknown>][] = [
      ['jubian_storyboard', { method: 'erase_subtitle', idempotency_key: 'k' }],
      ['jubian_video', { method: 'upscale', idempotency_key: 'k' }],
      ['jubian_asset', { method: 'confirm_casting', idempotency_key: 'k' }],
      ['jubian_asset', { method: 'remove', idempotency_key: 'k' }],
    ]
    for (const [toolName, args] of OTHERS) {
      expect(evaluateCall(call({ toolName, arguments: args, switches }))).toEqual({ kind: 'allow' })
    }
  })

  it('ignores a method that is not a string', () => {
    expect(evaluateCall(call({ toolName: 'jubian_video', arguments: { method: 7 } }))).toEqual({ kind: 'allow' })
  })

  it('refuses to guess a project when no workspace root can be resolved', () => {
    const text = reason(generate({ sessionCwd: undefined, configuredRoot: undefined }))
    expect(text).toContain('找不到工作目录')
    expect(text).toContain('门禁无法核对它引用的资产')
  })

  it('honors the switch', () => {
    expect(generate({ switches: { ...ALL_ON, reconcileFirst: false } })).toEqual({ kind: 'allow' })
  })
})

describe('retired MUSE tool names', () => {
  it.each(['drama', 'asset', 'shot', 'project', 'timeline', 'delivery'])('explains %s', (toolName) => {
    const text = reason(evaluateCall(call({ toolName, registered: false })))
    expect(text).toContain(`没有名为「${toolName}」的工具`)
    expect(text).toContain('已下线的 MUSE 工具名')
    expect(text).toContain('jubian_storyboard')
  })

  it('leaves a registered tool of the same name alone', () => {
    expect(evaluateCall(call({ toolName: 'asset', registered: true }))).toEqual({ kind: 'allow' })
  })

  it('leaves a genuinely unknown name to the registry', () => {
    expect(evaluateCall(call({ toolName: 'frobnicate', registered: false }))).toEqual({ kind: 'allow' })
  })

  it('honors the switch', () => {
    const decision = evaluateCall(call({
      toolName: 'asset',
      registered: false,
      switches: { ...ALL_ON, museToolNames: false },
    }))
    expect(decision).toEqual({ kind: 'allow' })
  })
})

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { evaluateCall } from '@deepseek-ai/dsh-guard-drama'
import type { GateCall, GateDecision } from '@deepseek-ai/dsh-guard-drama'
import {
  ALL_ON, MATCHED, PROJECT, PROMPTS, WORKSHOP, WORKSPACE, block, call, fakeReader, han, matchedJson,
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
    // The official-asset rule is switched off so this case isolates the key rule:
    // `jubian_storyboard.generate` is otherwise also a paid submission.
    const decision = evaluateCall(call({
      toolName,
      arguments: { method, idempotency_key: 'k-1', ...extra },
      switches: { ...ALL_ON, officialAssets: false },
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

  it.each(['旁白', '画外音', '画外声', '心声', '（OS）', 'VO'])('denies the narration marker %s', (marker) => {
    const script = `真人短剧写实风格\n${block(1, '1秒', '方恒：你好')}\n${marker}：他走了\n`
    const text = reason(write(PROMPTS, script))
    expect(text).toContain('短剧门禁拦下这次 write')
    expect(text).toContain('本格式没有旁白：把该台词落成画面内台词')
    expect(text).toContain('落不进画面内的段落回报失败，不要静默丢弃')
  })

  it('names the offending line in the narration refusal', () => {
    const script = '真人短剧写实风格\n【镜头1】\n时长：1秒\n旁白：他走了\n'
    expect(reason(write(PROMPTS, script))).toContain('第 4 行出现旁白/心声标记「旁白」')
  })

  it('does not read `voice_type` or `visual` as narration tokens', () => {
    const script = `真人短剧写实风格\n${block(1, '1秒', '方恒：你好')}`
    expect(write(PROMPTS, script)).toEqual({ kind: 'allow' })
  })

  it('denies a duration outside 1–4 seconds', () => {
    const script = `真人短剧写实风格\n${block(1, '5秒', `方恒：${han(45)}`)}`
    expect(reason(write(PROMPTS, script))).toContain('镜头1的时长「5秒」不合法')
  })

  it('denies a fractional duration', () => {
    const script = `真人短剧写实风格\n${block(1, '3.5秒', `方恒：${han(10)}`)}`
    expect(reason(write(PROMPTS, script))).toContain('小数秒和 5 秒及以上都不接受')
  })

  it('denies a block with no duration declaration', () => {
    const script = '真人短剧写实风格\n【镜头1】\n发声类型：action\n'
    expect(reason(write(PROMPTS, script))).toContain('镜头1没有「时长：」声明')
  })

  it('denies more than 36 effective characters', () => {
    const script = `真人短剧写实风格\n${block(1, '1秒', `方恒：${han(37)}`)}`
    expect(reason(write(PROMPTS, script))).toContain('镜头1的单镜有效字 37 超过 36')
  })

  it('denies a declared duration that contradicts the 9-characters-per-second rule', () => {
    const script = `真人短剧写实风格\n${block(1, '1秒', `方恒：${han(10)}`)}`
    const text = reason(write(PROMPTS, script))
    expect(text).toContain('10 个有效字按 9 有效字/秒应为 2 秒，实际写成 1 秒')
    expect(text).toContain('标点和空格不计')
  })

  it('counts only Han, letters, and digits', () => {
    const script = `真人短剧写实风格\n${block(1, '2秒', '方恒：你好，世界！abc 123')}`
    expect(write(PROMPTS, script)).toEqual({ kind: 'allow' })
  })

  it('gates the episode package copies as well as the prompts directory', () => {
    const path = join(PROJECT, 'episode_packages', '01', 'shot_script.txt')
    expect(write(path, `真人短剧写实风格\n${block(1, '1秒', '方恒：旁白说')}`).kind).toBe('deny')
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

  it('denies a duration outside 1–4 seconds', () => {
    expect(reason(write(MATCHED, matchedJson({ script_duration: 5, text: han(45) })))).toContain('镜头1的时长不合法（5）')
  })

  it('denies a fractional duration', () => {
    expect(reason(write(MATCHED, matchedJson({ script_duration: 2.5, text: han(20) })))).toContain('每镜必须是 1–4 的整数秒')
  })

  it('denies a missing duration', () => {
    expect(reason(write(MATCHED, matchedJson({ text: han(9) })))).toContain('镜头1的时长不合法（缺失）')
  })

  it('denies more than 36 effective characters', () => {
    expect(reason(write(MATCHED, matchedJson({ script_duration: 4, text: han(37) })))).toContain('单镜有效字 37 超过 36')
  })

  it('denies a duration that contradicts the dialogue length', () => {
    const text = reason(write(MATCHED, matchedJson({ script_duration: 3, text: han(10) })))
    expect(text).toContain('10 个有效字按 9 有效字/秒应为 2 秒，实际是 3 秒')
  })

  it('denies narration inside a shot prose field', () => {
    const text = reason(write(MATCHED, matchedJson({ script_duration: 1, text: han(9), visual: '（心声）他转身离开' })))
    expect(text).toContain('出现旁白/心声标记「心声」')
    expect(text).toContain('本格式没有旁白')
  })

  it('does not read a `voice_type` key or a word containing `vo`/`os` as narration', () => {
    // The unparseable document takes the raw-text fallback, which is the only
    // path where a JSON key could ever be mistaken for a marker.
    expect(write(MATCHED, '{ "voice_type": "dialogue", "visual": "provost closing"')).toEqual({ kind: 'allow' })
  })

  it('still catches a standalone VO value', () => {
    expect(reason(write(MATCHED, '{ "voice_type": "VO"'))).toContain('出现旁白/心声标记「VO」')
  })

  it('falls back to a raw-text narration scan when the JSON does not parse', () => {
    expect(write(MATCHED, '{ "shots": [ { "visual": "旁白：他走了" }').kind).toBe('deny')
    expect(write(MATCHED, '{ "shots": [ { "visual": "好" }').kind).toBe('allow')
  })

  it('leaves a JSON document with no shots container to the compiler', () => {
    expect(write(MATCHED, '{ "version": 4, "episode": "01" }')).toEqual({ kind: 'allow' })
  })

  it('gates the episode package copy', () => {
    const path = join(PROJECT, 'episode_packages', '01', 'matched.json')
    expect(write(path, matchedJson({ script_duration: 6, text: '' })).kind).toBe('deny')
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
    expect(reason(edit('时长：2秒', '时长：5秒'))).toContain('镜头1的时长「5秒」不合法')
  })

  it('denies an edit that reintroduces narration', () => {
    expect(reason(edit('主体状态追踪：在场', '主体状态追踪：在场\n旁白：他走了'))).toContain('本格式没有旁白')
  })

  it('replaces every occurrence with replace_all', () => {
    const decision = evaluateCall(call({
      toolName: 'edit',
      arguments: { file_path: PROMPTS, old_string: '时长：2秒', new_string: '时长：1秒', replace_all: true },
      reader: fakeReader({
        [PROMPTS]: `真人短剧写实风格\n${block(1, '2秒', '方恒：今天天气很好我们出门吧')}${block(2, '2秒', '方恒：今天天气很好我们出门吧')}`,
      }),
    }))
    expect(reason(decision)).toContain('镜头1声明的时长与台词不符')
  })

  it('treats `$&` in the new text literally, as the edit tool does', () => {
    expect(reason(edit('2秒', '$&'))).toContain('镜头1的时长「$&」不合法')
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
      arguments: { file_path: 'short-drama/demo-drama/prompts/01.txt', old_string: '在场', new_string: '在场\n旁白：他走了' },
      reader: fakeReader({ [PROMPTS]: before }),
    }))
    expect(reason(relativeEdit)).toContain('本格式没有旁白')
  })
})

describe('official assets before a paid submission', () => {
  const manifest = (official: boolean): string => JSON.stringify({ assets: [{ name: '方恒', official }] })

  /** A `jubian_storyboard.generate` call with a valid key. */
  function submit(overrides: Partial<GateCall> = {}): GateDecision {
    return evaluateCall(call({
      toolName: 'jubian_storyboard',
      arguments: { method: 'generate', idempotency_key: 'k', content_duration_ms: 12000, storyboard_id: 1 },
      ...overrides,
    }))
  }

  it('denies when no official asset record exists anywhere in the workshop', () => {
    const text = reason(submit())
    expect(text).toContain('jubian_storyboard.generate 会真实计费，但工作间里找不到 official=true 的正式资产记录')
    expect(text).toContain('先走资产三阶段门禁')
  })

  it('denies when the manifest exists but lists no official asset', () => {
    const reader = fakeReader({ [join(PROJECT, 'assets_manifest.json')]: manifest(false) }, { [WORKSHOP]: ['demo-drama'] })
    expect(submit({ reader }).kind).toBe('deny')
  })

  it('allows a manifest at the workshop root', () => {
    const reader = fakeReader({ [join(WORKSHOP, 'assets_manifest.json')]: manifest(true) })
    expect(submit({ reader })).toEqual({ kind: 'allow' })
  })

  it('allows a manifest inside a child project directory', () => {
    const reader = fakeReader({ [join(PROJECT, 'assets_manifest.json')]: manifest(true) }, { [WORKSHOP]: ['demo-drama'] })
    expect(submit({ reader })).toEqual({ kind: 'allow' })
  })

  it('allows a bare array manifest', () => {
    const reader = fakeReader({ [join(PROJECT, 'assets_manifest.json')]: JSON.stringify([{ official: true }]) }, { [WORKSHOP]: ['demo-drama'] })
    expect(submit({ reader })).toEqual({ kind: 'allow' })
  })

  it('allows a manifest whose assets are keyed by id', () => {
    const assets = { assets: { fang: { official: true } } }
    const reader = fakeReader({ [join(PROJECT, 'assets_manifest.json')]: JSON.stringify(assets) }, { [WORKSHOP]: ['demo-drama'] })
    expect(submit({ reader })).toEqual({ kind: 'allow' })
  })

  it('falls back to a completed official_assets stage when no manifest exists', () => {
    const state = JSON.stringify({ version: 3, stages: { official_assets: { status: 'completed' } } })
    const reader = fakeReader({ [join(PROJECT, 'pipeline_state.json')]: state }, { [WORKSHOP]: ['demo-drama'] })
    expect(submit({ reader })).toEqual({ kind: 'allow' })
  })

  it('accepts a per-episode official_assets completion', () => {
    const state = JSON.stringify({ version: 3, stages: {}, episodes: { '01': { official_assets: { status: 'completed' } } } })
    const reader = fakeReader({ [join(PROJECT, 'pipeline_state.json')]: state }, { [WORKSHOP]: ['demo-drama'] })
    expect(submit({ reader })).toEqual({ kind: 'allow' })
  })

  it('does not accept a merely running official_assets stage', () => {
    const state = JSON.stringify({ stages: { official_assets: { status: 'running' } } })
    const reader = fakeReader({ [join(PROJECT, 'pipeline_state.json')]: state }, { [WORKSHOP]: ['demo-drama'] })
    expect(submit({ reader }).kind).toBe('deny')
  })

  it('ignores unreadable or malformed evidence', () => {
    const reader = fakeReader({ [join(PROJECT, 'assets_manifest.json')]: '{ not json' }, { [WORKSHOP]: ['demo-drama'] })
    expect(submit({ reader }).kind).toBe('deny')
  })

  it('prefers an explicit projectRoot over the workshop root', () => {
    const explicit = join(WORKSPACE, 'elsewhere')
    const reader = fakeReader({ [join(explicit, 'assets_manifest.json')]: manifest(true) })
    expect(submit({ reader, projectRoot: explicit })).toEqual({ kind: 'allow' })
  })

  it('does not block asset generation, which runs before any official asset exists', () => {
    const decision = evaluateCall(call({
      toolName: 'jubian_video',
      arguments: { method: 'image_generate', asset_name: 'a', asset_type: 1, prompt: 'p', idempotency_key: 'k' },
    }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('does not block a storyboard read method', () => {
    expect(submit({ arguments: { method: 'get', storyboard_id: 1 } })).toEqual({ kind: 'allow' })
  })

  it('allows when no workspace root can be resolved', () => {
    expect(submit({ sessionCwd: undefined, configuredRoot: undefined })).toEqual({ kind: 'allow' })
  })

  it('falls back to the configured root when the session states no cwd', () => {
    const reader = fakeReader({ [`${PROJECT}\\assets_manifest.json`]: manifest(true) }, { [WORKSHOP]: ['demo-drama'] })
    expect(submit({ sessionCwd: undefined, configuredRoot: WORKSPACE, reader })).toEqual({ kind: 'allow' })
  })

  it('falls through a relative session cwd to the configured root', () => {
    const reader = fakeReader({ [join(PROJECT, 'assets_manifest.json')]: manifest(true) }, { [WORKSHOP]: ['demo-drama'] })
    expect(submit({ sessionCwd: 'relative/path', configuredRoot: WORKSPACE, reader })).toEqual({ kind: 'allow' })
    expect(submit({ sessionCwd: 'relative/path', configuredRoot: WORKSPACE }).kind).toBe('deny')
    expect(submit({ sessionCwd: '   ', configuredRoot: WORKSPACE }).kind).toBe('deny')
  })

  it('honors the switch', () => {
    expect(submit({ switches: { ...ALL_ON, officialAssets: false } })).toEqual({ kind: 'allow' })
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

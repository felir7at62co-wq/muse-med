import { describe, expect, it } from 'vitest'
import { effectiveChars, parseShotScript, speechSeconds } from '../src/script.ts'
import type { ShotIssue } from '../src/types.ts'
import { NEGATIVE_PROMPT, actionShot, scriptOf, shot, speakingShot } from './harness.ts'

/** Parse with the compiler default the drama pipeline ships. */
function parse(text: string, actionShotSeconds = 2): ReturnType<typeof parseShotScript> {
  return parseShotScript(text, { actionShotSeconds })
}

/** The issues carrying one code. */
function codes(issues: readonly ShotIssue[]): string[] {
  return issues.map(issue => issue.code)
}

describe('effective characters and derived duration', () => {
  it('counts Han characters, Latin letters, and digits only', () => {
    expect(effectiveChars('宝宝……那是我的宝宝！')).toBe(8)
    expect(effectiveChars('a1中')).toBe(3)
    expect(effectiveChars('……，。！')).toBe(0)
    expect(effectiveChars('')).toBe(0)
  })

  it('derives whole seconds at nine effective characters per second', () => {
    expect(speechSeconds(0)).toBe(1)
    expect(speechSeconds(1)).toBe(1)
    expect(speechSeconds(9)).toBe(1)
    expect(speechSeconds(10)).toBe(2)
    expect(speechSeconds(36)).toBe(4)
  })
})

describe('a conforming script', () => {
  const text = scriptOf(
    speakingShot(1, '苏晚：宝宝……那是我的宝宝！', ['核心场景：后厨', '关键道具：奶瓶', '出镜人物：苏晚']),
    actionShot(2, ['动作复杂度：复杂', '子任务边界：是']),
  )

  it('parses every shot with its derived facts and no issues', () => {
    const result = parse(text)
    expect(result.issues).toEqual([])
    expect(result.shots.map(item => item.shot)).toEqual([1, 2])
    expect(result.shots[0]).toMatchObject({
      line: 2,
      voiceType: 'dialogue',
      speaker: '苏晚',
      text: '宝宝……那是我的宝宝！',
      effectiveChars: 8,
      durationSeconds: 1,
      durationSource: 'speech',
      offscreen: false,
      charactersField: '苏晚',
      sceneField: '后厨',
      propsField: '奶瓶',
      directorFormat: true,
      breakAfter: false,
    })
    expect(result.shots[1]).toMatchObject({
      voiceType: 'action',
      speaker: '',
      text: '',
      effectiveChars: 0,
      durationSeconds: 4,
      durationSource: 'complexity',
      breakAfter: true,
    })
  })

  it('strips the style line into the prompt text and never carries a duration', () => {
    const visual = parse(text).shots[0]?.visual ?? ''
    expect(visual.startsWith('真人短剧写实风格\n【镜头1】')).toBe(true)
    expect(visual).toContain(NEGATIVE_PROMPT)
    expect(visual).not.toContain('时长')
  })

  it('reports the marker line of every shot', () => {
    const result = parse(text)
    expect(result.shots[0]?.line).toBe(2)
    expect(result.shots[1]?.line).toBeGreaterThan(result.shots[0]?.line ?? 0)
  })
})

describe('script-level rules', () => {
  it('refuses a script with no shot marker', () => {
    const result = parse('真人短剧写实风格\n没有任何镜头。')
    expect(codes(result.issues)).toEqual(['no_shots'])
    expect(result.shots).toEqual([])
  })

  it('requires the style line before every shot and fails only the offending one', () => {
    const withoutStyle = scriptOf(speakingShot(1), speakingShot(2).replace('真人短剧写实风格\n', ''))
    const result = parse(withoutStyle)
    expect(codes(result.issues)).toEqual(['missing_style_line'])
    expect(result.issues[0]).toMatchObject({ shot: 2, severity: 'warning' })
  })

  it('refuses non-contiguous shot numbers', () => {
    const result = parse(scriptOf(speakingShot(1), actionShot(3)))
    expect(codes(result.issues)).toEqual(['shot_numbering'])
    expect(result.issues[0]?.message).toContain('应为 2')
  })
})

describe('the spoken track', () => {
  it.each(['', '说话人：苏晚\n'])('preserves narration punctuation and explicit speaker: %s', (speaker) => {
    const result = parse(`【镜头1】\n主体状态追踪：\n发声类型：心声\n${speaker}旁白：他说：明天再来。`)
    expect(result.shots[0]).toMatchObject({ text: '他说：明天再来。', speaker: speaker ? '苏晚' : '', voiceType: 'vo' })
    expect(result.issues.filter(issue => issue.severity === 'failure')).toEqual([])
  })
  it('refuses narration, inner monologue, and stage-narration markers', () => {
    const voice = parse(scriptOf(speakingShot(1, '苏晚：原文台词', ['发声类型：心声'])))
    expect(codes(voice.issues)).toContain('narration_marker')
    expect(voice.issues[0]).toMatchObject({ severity: 'warning' })
    expect(voice.issues[0]?.message).toContain('作为 vo')
    expect(voice.shots[0]).toMatchObject({ voiceType: 'vo', text: '原文台词', speaker: '苏晚' })

    const label = parse(scriptOf(speakingShot(1, '旁白：这是旁白')))
    expect(codes(label.issues)).toContain('narration_marker')

    const speaker = parse(scriptOf(speakingShot(1, 'OS：他低声说')))
    expect(codes(speaker.issues)).toContain('narration_marker')
  })

  it('refuses a speech label that is itself a narration marker', () => {
    const result = parse(scriptOf(actionShot(1, ['旁白：这是旁白'])))
    expect(codes(result.issues)).toContain('narration_marker')
  })

  it('refuses a second speech line', () => {
    const result = parse(scriptOf(speakingShot(1, '苏晚：第一句', ['台词：苏晚：第二句'])))
    expect(codes(result.issues)).toEqual(['multiple_speech_lines'])
  })

  it('requires the action marker on a shot without speech', () => {
    const result = parse(scriptOf(shot(1, ['景别：近景', '主体状态追踪：', `负面：${NEGATIVE_PROMPT}`])))
    expect(codes(result.issues)).toEqual(['missing_voice_type'])
  })

  it('accepts a silent shot that declares the action marker', () => {
    const result = parse(scriptOf(actionShot(1)))
    expect(result.issues).toEqual([])
    expect(result.shots[0]?.voiceType).toBe('action')
  })

  it('reads the older 语音类型 field and the bare 画外音 label', () => {
    const legacy = parse(scriptOf(shot(1, ['语音类型：action', '主体状态追踪：', NEGATIVE_PROMPT])))
    expect(legacy.issues).toEqual([])
    expect(legacy.shots[0]?.voiceType).toBe('action')

    const offscreen = parse(scriptOf(speakingShot(1, '苏晚：原文台词', ['发声类型：画外音'])))
    expect(offscreen.shots[0]?.voiceType).toBe('vo')
    expect(offscreen.shots[0]?.offscreen).toBe(true)
  })

  it('refuses a shot that declares action and still writes a speech line', () => {
    const result = parse(scriptOf(speakingShot(1, '苏晚：原文台词', ['发声类型：action'])))
    expect(codes(result.issues)).toEqual(['action_voice_with_dialogue'])
  })

  it('refuses empty, placeholder, and speaker-only dialogue lines', () => {
    expect(codes(parse(scriptOf(speakingShot(1, '苏晚：'))).issues)).toEqual(['empty_dialogue_line'])
    expect(codes(parse(scriptOf(speakingShot(1, '苏晚：……'))).issues)).toEqual(['empty_dialogue_line'])
    expect(codes(parse(scriptOf(speakingShot(1, '无'))).issues)).toEqual(['placeholder_dialogue'])
    expect(codes(parse(scriptOf(speakingShot(1, '苏晚：无。'))).issues)).toEqual(['placeholder_dialogue'])
  })

  it('resolves the same-scene off-screen continuation form', () => {
    const result = parse(scriptOf(speakingShot(1, '苏晚（画外音）：错过了老爷子的机会！')))
    expect(result.issues).toEqual([])
    expect(result.shots[0]).toMatchObject({ voiceType: 'vo', offscreen: true, speaker: '苏晚' })
  })

  it('treats a bare 画外音 speech label as the same continuation', () => {
    const result = parse(scriptOf(shot(1, ['景别：近景', '主体状态追踪：', '画外音：苏晚：原文台词'])))
    expect(result.issues).toEqual([])
    expect(result.shots[0]).toMatchObject({ voiceType: 'vo', offscreen: true, speaker: '苏晚', text: '原文台词' })
  })

  it('refuses a narration marker on the speaker prefix itself', () => {
    const result = parse(scriptOf(speakingShot(1, '旁白：这是旁白')))
    expect(result.issues.some(issue => issue.code === 'narration_marker')).toBe(true)
  })

  it('keeps the whole line as text outside the director format', () => {
    const legacy = scriptOf(shot(1, ['语音类型：dialogue', '台词：苏晚：原文台词']))
    const result = parse(legacy)
    expect(result.issues).toEqual([])
    expect(result.shots[0]).toMatchObject({ speaker: '', text: '苏晚：原文台词', directorFormat: false })
  })
})

describe('the character field', () => {
  it('refuses the 无 placeholder in both spellings', () => {
    const plain = parse(scriptOf(speakingShot(1, '苏晚：原文台词', ['出镜人物：无'])))
    expect(codes(plain.issues)).toEqual(['characters_placeholder'])
    expect(plain.issues[0]?.message).toContain('整行省略')

    const bracketed = parse(scriptOf(speakingShot(1, '苏晚：原文台词', ['出镜人物：【无】'])))
    expect(codes(bracketed.issues)).toEqual(['characters_placeholder'])

    const shell = parse(scriptOf(speakingShot(1, '苏晚：原文台词', ['出镜人物【无】'])))
    expect(codes(shell.issues)).toEqual(['characters_placeholder'])
  })

  it('reads the older gate shell bracket spelling of a field', () => {
    const result = parse(scriptOf(actionShot(1, ['核心场景【后厨】', '关键道具【奶瓶】'])))
    expect(result.issues).toEqual([])
    expect(result.shots[0]).toMatchObject({ sceneField: '后厨', propsField: '奶瓶' })
  })

  it('accepts an omitted field for a shot that binds no character', () => {
    const result = parse(scriptOf(actionShot(1)))
    expect(result.shots[0]?.charactersField).toBe('')
    expect(result.issues).toEqual([])
  })
})

describe('the packing duration rules', () => {
  it('warns above fifteen effective characters and compiles any number of them', () => {
    const sixteen = parse(scriptOf(speakingShot(1, `苏晚：${'字'.repeat(16)}`)))
    expect(sixteen.issues.map(issue => issue.severity)).toEqual(['warning'])
    expect(codes(sixteen.issues)).toEqual(['speech_above_writing_threshold'])
    expect(sixteen.shots[0]?.durationSeconds).toBe(2)

    const fifteen = parse(scriptOf(speakingShot(1, `苏晚：${'字'.repeat(15)}`)))
    expect(fifteen.issues).toEqual([])
    expect(fifteen.shots[0]?.durationSeconds).toBe(2)
  })

  it('refuses more than thirty-six effective characters', () => {
    const result = parse(scriptOf(speakingShot(1, `苏晚：${'字'.repeat(37)}`)))
    expect(codes(result.issues)).toEqual(['speech_too_long'])
    expect(result.shots[0]?.durationSeconds).toBe(5)
  })

  it('maps every complexity label onto its seconds', () => {
    const labels = [['简单', 1], ['一般', 2], ['较复杂', 3], ['复杂', 4]] as const
    for (const [label, seconds] of labels) {
      const result = parse(scriptOf(actionShot(1, [`动作复杂度：${label}`])))
      expect(result.issues).toEqual([])
      expect(result.shots[0]).toMatchObject({ durationSeconds: seconds, durationSource: 'complexity' })
    }
  })

  it('refuses an unknown complexity label and falls back to the compiler default', () => {
    const result = parse(scriptOf(actionShot(1, ['动作复杂度：中等'])), 3)
    expect(codes(result.issues)).toEqual(['unknown_action_complexity'])
    expect(result.shots[0]).toMatchObject({ durationSeconds: 3, durationSource: 'default' })
  })

  it('refuses a complexity label on a speaking shot', () => {
    const result = parse(scriptOf(speakingShot(1, '苏晚：原文台词', ['动作复杂度：复杂'])))
    expect(codes(result.issues)).toEqual(['action_complexity_on_speaking_shot'])
    expect(result.issues[0]?.severity).toBe('warning')
    expect(result.shots[0]?.durationSource).toBe('speech')
  })

  it('charges an unlabelled silent shot the configured default', () => {
    expect(parse(scriptOf(actionShot(1))).shots[0]).toMatchObject({ durationSeconds: 2, durationSource: 'default' })
    expect(parse(scriptOf(actionShot(1)), 3).shots[0]).toMatchObject({ durationSeconds: 3, durationSource: 'default' })
  })
})

describe('durations written into the script', () => {
  it('rejects a present but empty duration field', () => {
    const result = parse(scriptOf(speakingShot(1, '苏晚：你好', ['时长：'])))
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: 'failure', code: 'legacy_duration_invalid' }))
  })
  it('strips a legacy duration line out of the prompt text', () => {
    const result = parse(scriptOf(speakingShot(1, '苏晚：宝宝……那是我的宝宝！', ['时长：1秒'])))
    expect(result.issues).toEqual([])
    expect(result.shots[0]?.visual).not.toContain('时长')
  })

  it('refuses a legacy duration that disagrees with the derived seconds', () => {
    const result = parse(scriptOf(speakingShot(1, '苏晚：宝宝……那是我的宝宝！', ['时长：3秒'])))
    expect(codes(result.issues)).toEqual(['legacy_duration_mismatch'])
    expect(result.issues[0]).toMatchObject({ severity: 'warning' })
    expect(result.shots[0]).toMatchObject({ durationSeconds: 3, durationSource: 'declared' })
  })

  it('refuses a legacy duration outside whole 1–4 seconds', () => {
    const result = parse(scriptOf(speakingShot(1, '苏晚：宝宝……那是我的宝宝！', ['时长：2.5秒'])))
    expect(codes(result.issues)).toEqual(['legacy_duration_invalid'])
  })

  it('refuses any other seconds expression in the shot body', () => {
    const result = parse(scriptOf(speakingShot(1, '苏晚：宝宝……那是我的宝宝！', ['运镜：相机固定，保持 3 秒不动'])))
    expect(codes(result.issues)).toEqual(['seconds_in_shot_body'])
    expect(result.issues[0]).toMatchObject({ severity: 'warning' })
    expect(result.issues[0]?.message).toContain('正文秒数不改变打包时长')
  })
})

describe('the director format', () => {
  it('requires the fixed negative prompt', () => {
    const result = parse(scriptOf(speakingShot(1).replace(`\n${NEGATIVE_PROMPT}`, '')))
    expect(codes(result.issues)).toEqual(['missing_negative_prompt'])
  })

  it('does not require it outside the director format', () => {
    const result = parse(scriptOf(shot(1, ['语音类型：action']).replace(`\n${NEGATIVE_PROMPT}`, '')))
    expect(result.issues).toEqual([])
  })
})

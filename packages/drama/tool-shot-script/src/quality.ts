/** Declared action stages and scene-local continuity checks before video generation. */
import type { IssueCode, ParsedShot, ShotIssue } from './types.ts'

interface TrackedState {
  location: string
  state: string
  count: number
  shot: number
}

const STAGES = ['动作起点', '接触与支撑', '动作落点']
const PLACEHOLDER = /^(?:无|待补|待定|同上|略|TODO)$/iu

function values(body: string, name: string): string[] {
  return [...body.matchAll(new RegExp(`^${name}[：:](.*)$`, 'gm'))].map(row => row[1]?.trim() ?? '')
}

/**
 * Resolve an authored source period without inventing a new scene for a cut.
 * @param shot - Shot retaining an explicit continuity period or source-scene heading.
 * @returns The authored period, or an empty string for legacy scene-only tracking.
 */
export function continuityPeriod(shot: ParsedShot): string {
  return values(shot.visual, '连续性场次')[0]
    ?? /^来源场次（原文段落）：([^；\n]+)/mu.exec(shot.visual)?.[1] ?? ''
}

/**
 * Resolve scene time for every shot without deriving it from dialogue or changing source text.
 * @param shots - Ordered shots with optional source headings and dedicated time declarations.
 * @returns Inherited time labels, unresolved shot numbers and malformed or unexplained-change findings.
 */
export function reviewSceneTimes(shots: readonly ParsedShot[]): {
  times: Map<number, string>
  unresolved: number[]
  issues: ShotIssue[]
} {
  const times = new Map<number, string>()
  const unresolved: number[] = []
  const issues: ShotIssue[] = []
  const history = new Map<string, { time: string; shot: number }>()
  const periods = new Map<string, string>()
  for (const shot of shots) {
    const period = continuityPeriod(shot) || periods.get(shot.sceneField) || ''
    periods.set(shot.sceneField, period)
    const key = JSON.stringify([shot.sceneField, period])
    const declared = values(shot.visual, '场景时段')
    const reasons = values(shot.visual, '时段变化依据')
    const malformed = declared.length > 1 || reasons.length > 1
      || declared.some(value => !value || PLACEHOLDER.test(value))
      || reasons.some(value => !value || PLACEHOLDER.test(value)) || reasons.length > 0 && !declared.length
    if (malformed) {
      issues.push({ code: 'scene_time_declaration_invalid', severity: 'failure', shot: shot.shot, line: shot.line,
        message: `镜头${shot.shot}的场景时段及可选时段变化依据须各写至多一次且有实际内容；变化依据需要本镜明确时段，不用占位词。` })
      unresolved.push(shot.shot)
      continue
    }
    const sourceHeading = /^来源场次（原文段落）：(.+)$/mu.exec(shot.visual)?.[1] ?? ''
    const headingTime = /(?:^|\s)([^\s；|]+)\s+(?:内|外|内\/外|外\/内)(?:\s|；|$)/u.exec(sourceHeading)?.[1]
    const previous = history.get(key)
    const time = declared[0] ?? previous?.time ?? headingTime ?? values(shot.visual, '时段连续性')[0]
    if (!time) {
      unresolved.push(shot.shot)
      continue
    }
    if (declared.length && previous && previous.time !== time && !reasons.length) {
      issues.push({ code: 'scene_time_change_unexplained', severity: 'warning', shot: shot.shot, line: shot.line,
        message: `镜头${shot.shot}同场时段由镜头${previous.shot}的「${previous.time}」改为「${time}」，缺少原文时段变化依据；切镜及分包不推进剧情时间，同义表达先核对并统一用词。` })
    }
    times.set(shot.shot, time)
    history.set(key, { time, shot: shot.shot })
  }
  return { times, unresolved, issues }
}

/**
 * Check authored stages and state changes without inferring visual facts from prose.
 * @param shots - Parsed shots in source order, retaining their authored quality fields.
 * @returns Findings and authored preceding states keyed by shot number for package openings.
 */
export function reviewShotQuality(shots: readonly ParsedShot[]): { issues: ShotIssue[]; openings: Map<number, string> } {
  const issues: ShotIssue[] = [...reviewSceneTimes(shots).issues]
  const openings = new Map<number, string>()
  const scenes = new Map<string, Map<string, TrackedState>>()
  const periods = new Map<string, string>()
  for (const shot of shots) {
    const add = (code: IssueCode, message: string, severity: 'warning' | 'failure' = 'warning'): void => {
      issues.push({ code, message: `镜头${shot.shot}${message}`, severity, shot: shot.shot, line: shot.line })
    }
    const stages = STAGES.map(name => values(shot.visual, name))
    const hasStages = stages.some(rows => rows.length > 0)
    if (hasStages && stages.some(rows => rows.length !== 1 || !rows[0] || PLACEHOLDER.test(rows[0]))) {
      add('action_stages_invalid', '动作起点、接触与支撑、动作落点须各写一次且有实际内容；仅为运镜的镜头不必添加这些字段。', 'failure')
    }
    const complexity = values(shot.visual, '动作复杂度')[0]
    const ordered = values(shot.visual, '动作状态').some(body =>
      /先(?!前|生|天|祖|辈).+(?:再|然后|随后|接着|最后)/u.test(body))
    if (complexity === '较复杂' || complexity === '复杂' || ordered) {
      if (!hasStages) add('action_stages_missing', ordered
        ? '动作状态含明确先后步骤：先对照原文确认执行者、前提及动作确实发生，再写起点、接触与支撑、落点，并统一手部状态；台词中的指令或条件不自动成为当场动作。'
        : '包含复杂动作：生成前按原文写清动作起点、接触与支撑、动作落点；不以删除动作或改成静态姿势代替。')
      if (shot.durationSource !== 'declared') add('performance_budget_missing', ordered
        ? '先后动作仍使用估算时长；按原文排演各步骤、发声与反应，填写表演预算或经核对的时长，不默认可同时完成，也不加速或删步骤凑时长。'
        : '复杂表演仍使用估算时长；自然排演动作、台词与反应，填写独立表演预算或经核对的时长，不把3–4秒估算当作完成保证。')
    }

    const segments = values(shot.visual, '连续性场次')
    if (segments.length > 1 || segments.some(value => !value || PLACEHOLDER.test(value))) {
      add('continuity_declaration_invalid', '连续性场次只能写一个有原文依据的场次标识，不能通过逐镜改标识隐藏状态变化。', 'failure')
    }
    const rows = values(shot.visual, '连续性状态')
    const changeRows = values(shot.visual, '连续性变化')
    const scene = shot.sceneField.trim()
    if (!scene) {
      if (rows.length || changeRows.length) add('continuity_declaration_invalid', '连续性状态需要明确核心场景；不能跨未知场景比较。', 'failure')
      continue
    }
    const period = continuityPeriod(shot) || periods.get(scene) || ''
    periods.set(scene, period)
    const key = JSON.stringify([scene, period])
    const history = scenes.get(key) ?? new Map<string, TrackedState>()
    scenes.set(key, history)
    if (history.size) openings.set(shot.shot,
      '本包动作开始前沿用的同场状态（仅来自已声明的镜头落点；变化须按本包原文动作发生，不改变既定取景范围）：\n'
      + [...history].map(([id, state]) => `对象${id}：位置=${state.location}；状态=${state.state}；数量=${state.count}。`).join('\n'))
    const current = new Map<string, TrackedState>()
    const changes = new Map<string, string>()
    for (const row of rows) {
      const parts = row.split(/[｜|]/u).map(value => value.trim())
      const [id, location, state, quantity] = parts
      const count = Number(quantity)
      if (parts.length !== 4 || !id || !location || !state || !quantity || parts.some(value => PLACEHOLDER.test(value))
        || !/^(?:0|[1-9]\d*)$/u.test(quantity) || !Number.isSafeInteger(count) || current.has(id)) {
        add('continuity_declaration_invalid', '连续性状态须为「对象标识｜固定位置｜形态或姿态｜非负整数数量」，同镜对象标识不得重复；标识跟踪具体对象，不代表场景总数。', 'failure')
        continue
      }
      current.set(id, { location, state, count, shot: shot.shot })
    }
    for (const row of changeRows) {
      const parts = row.split(/[｜|]/u).map(value => value.trim())
      const [id, basis] = parts
      if (parts.length !== 2 || !id || !basis || PLACEHOLDER.test(basis) || changes.has(id) || !current.has(id)) {
        add('continuity_declaration_invalid', '连续性变化须为「本镜对象标识｜原文动作或时空变化依据」，对象须同时声明当前状态；依据不能用占位词。', 'failure')
        continue
      }
      changes.set(id, basis)
    }
    for (const [id, state] of current) {
      const previous = history.get(id)
      if (previous && (previous.location !== state.location || previous.state !== state.state || previous.count !== state.count)
        && !changes.has(id)) {
        add('continuity_change_unexplained', `「${id}」相对镜头${previous.shot}的位置、形态或数量改变，缺少连续性变化依据；核对原文并统一状态用语。切镜、特写或本镜未列出对象不重置同场状态。`)
      }
      history.set(id, state)
    }
  }
  return { issues, openings }
}

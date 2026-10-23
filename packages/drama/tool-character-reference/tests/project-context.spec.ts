import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type SettingsForms from '@deepseek-ai/dsh-settings'
import type { Session } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { createProjectContext } from '../src/project-context.ts'

function project(id?: number, title?: string, characters?: readonly object[]): string {
  return JSON.stringify({
    ...(id === undefined ? {} : { jubian_script_id: id }),
    project_bible: {
      schema_version: 1,
      revision: 1,
      ...(title === undefined ? {} : { title }),
      ...(characters === undefined ? {} : { characters }),
      initial_budget_cents: 0,
      delivery: { width: 1440, height: 2560, fps: 60, min_bitrate_mbps: 4.6 },
    },
  })
}

function fixture() {
  const ctx = new Context()
  const settings = { describe: () => [{ ns: 'drama-settings', value: {
    seriesBudgetCents: 400_000,
    deliverySpec: { width: 1440, height: 2560, fps: 60, minBitrateMbps: 4.6 },
  } }] } as SettingsForms
  const projects = createProjectContext(ctx, settings)
  const session = (cwd?: string) => ({ header: { cwd } }) as Session
  const message = (owner: Session, text: string, kind = 'user', contentType = 'text') => {
    ctx.emit('session/event', owner, { type: 'user/message', seq: 1,
      data: { source: { kind }, content: [{ type: contentType, text }] },
    } as never)
  }
  return { projects, session, message }
}

it('uses only a unique valid nested project without a human selection', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-character-unique-project-')))
  const workshop = join(root, 'short-drama')
  const first = join(workshop, 'first')
  const second = join(workshop, 'second')
  const { projects, session } = fixture()
  const current = session(root)
  try {
    await expect(projects.resolveCurrent(current)).rejects.toThrow('Select the current')
    await mkdir(first, { recursive: true })
    await writeFile(join(first, 'project_config.json'), project(91001, '示例项目甲'))
    expect(await projects.resolveCurrent(current)).toBe(first)
    expect(await projects.select(current, 91001)).toMatchObject({ script_id: 91001 })
    await expect(projects.select(current, 91002)).rejects.toThrow('explicitly identify')

    await writeFile(join(first, 'project_config.json'), project(undefined, '示例项目甲'))
    await expect(projects.resolveCurrent(current)).rejects.toThrow('Select the current')
    await writeFile(join(first, 'project_config.json'), project(91001, '示例项目甲'))

    await mkdir(second)
    await writeFile(join(second, 'project_config.json'), project(91002, '示例项目乙'))
    await expect(projects.resolveCurrent(current)).rejects.toThrow('Select the current')
    await expect(projects.select(current, 91001)).rejects.toThrow('explicitly identify')
    await rm(second, { recursive: true })

    const escape = join(workshop, 'escape')
    await symlink(root, escape, 'junction')
    await expect(projects.resolveCurrent(current)).rejects.toThrow('safely inspect')
    await rm(escape)
    expect(await projects.resolveCurrent(current)).toBe(first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('requires a current human project choice and revalidates the selected directory', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-character-projects-')))
  const workshop = join(root, 'short-drama')
  const first = join(workshop, 'first')
  const second = join(workshop, 'second')
  const { projects, session, message } = fixture()
  const current = session(root)
  try {
    await mkdir(first, { recursive: true })
    await mkdir(second)
    await writeFile(join(first, 'project_config.json'), project(91001, '示例项目甲', [
      { character_id: 'char_alpha', name: '示例角色甲', role_class: 'important_support',
        asset_id: 81002 },
    ]))
    await writeFile(join(second, 'project_config.json'), project(91002, '示例项目乙'))
    expect(await projects.list(current)).toEqual([
      { script_id: 91001, title: '示例项目甲' },
      { script_id: 91002, title: '示例项目乙' },
    ])
    await expect(projects.resolveCurrent(current)).rejects.toThrow('Select the current')
    await expect(projects.select(current, 0)).rejects.toThrow('valid project ID')
    await expect(projects.select(session(), 91001)).rejects.toThrow('Session workspace')
    await expect(projects.list(session())).rejects.toThrow('Session workspace')
    await expect(projects.resolveCurrent(session())).rejects.toThrow('Session workspace')
    await expect(projects.select(current, 91001)).rejects.toThrow('explicitly identify')
    message(current, '91001', 'tool')
    await expect(projects.select(current, 91001)).rejects.toThrow('explicitly identify')
    message(current, '91001', 'user', 'image')
    await expect(projects.select(current, 91001)).rejects.toThrow('explicitly identify')
    message(current, '请使用剧变项目 91001')
    await expect(projects.select(current, 91002)).rejects.toThrow('explicitly identify')
    expect(await projects.select(current, 91001)).toEqual({ script_id: 91001, title: '示例项目甲',
      characters: [{ character_id: 'char_alpha', name: '示例角色甲', role_class: 'important_support',
        asset_id: 81002 }],
    })
    expect(await projects.resolveCurrent(current)).toBe(first)
    message(current, '现在请改用剧变项目 91002')
    await expect(projects.resolveCurrent(current)).rejects.toThrow('names another project')
    expect(await projects.select(current, 91002)).toMatchObject({ script_id: 91002 })
    expect(await projects.resolveCurrent(current)).toBe(second)
    message(current, '回到示例项目甲')
    expect(await projects.select(current, 91001)).toMatchObject({ script_id: 91001 })
    expect(await projects.resolveCurrent(current)).toBe(first)
    await writeFile(join(first, 'project_config.json'), project(91003, '示例项目甲'))
    message(current, '继续使用项目 91001')
    await expect(projects.resolveCurrent(current)).rejects.toThrow('no longer valid')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('requires an explicit switch from a root project to a valid nested project', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-character-root-project-')))
  const nested = join(root, 'short-drama', 'nested')
  const { projects, session, message } = fixture()
  const current = session(root)
  try {
    await mkdir(nested, { recursive: true })
    await writeFile(join(root, 'project_config.json'), project(92001, '根项目'))
    await writeFile(join(nested, 'project_config.json'), project(92002, '子项目'))
    expect(await projects.resolveCurrent(current)).toBe(root)

    message(current, '请改用项目 92001 或 92002')
    await expect(projects.select(current, 92002)).rejects.toThrow('explicitly identify')

    message(current, '请改用项目 92002')
    await expect(projects.resolveCurrent(current)).rejects.toThrow('names another project')
    expect(await projects.select(current, 92002)).toMatchObject({ script_id: 92002 })
    expect(await projects.resolveCurrent(current)).toBe(nested)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects unsafe or ambiguous project discovery without leaking local paths', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-character-project-safety-')))
  const workshop = join(root, 'short-drama')
  const { projects, session, message } = fixture()
  const current = session(root)
  try {
    await expect(projects.list(session(''))).rejects.toThrow('safely inspect')
    await mkdir(workshop)
    const first = join(workshop, 'first')
    const second = join(workshop, 'second')
    await mkdir(first)
    await mkdir(second)
    await writeFile(join(first, 'project_config.json'), project(1, '同名'))
    await writeFile(join(second, 'project_config.json'), project(2, '同名'))
    message(current, '请使用同名项目')
    await expect(projects.select(current, 1)).rejects.toThrow('explicitly identify')
    message(current, '请使用项目 1')
    expect(await projects.select(current, 1)).toMatchObject({ script_id: 1 })
    await writeFile(join(first, 'project_config.json'), project(undefined, '同名'))
    await expect(projects.resolveCurrent(current)).rejects.toThrow('no longer valid')
    expect(await projects.list(current)).toEqual([{ script_id: 2, title: '同名' }])
    await writeFile(join(first, 'project_config.json'), project(1))
    expect(await projects.list(current)).toContainEqual({ script_id: 1, title: null })
    await writeFile(join(first, 'project_config.json'), project(1, 'x'.repeat(161)))
    expect(await projects.list(current)).toContainEqual({ script_id: 1, title: null })
    await writeFile(join(first, 'project_config.json'), project(1, 'bad\u202e title'))
    expect(await projects.list(current)).toContainEqual({ script_id: 1, title: null })
    await writeFile(join(first, 'project_config.json'), project(1, '同名', Array.from({ length: 129 }, (_, index) => ({
      character_id: `char_${index}`, name: `角色${index}`,
    }))))
    await expect(projects.list(current)).rejects.toThrow('safely inspect')
    await writeFile(join(first, 'project_config.json'), project(1, '同名', [
      { character_id: 'x'.repeat(129), name: '角色' },
    ]))
    await expect(projects.list(current)).rejects.toThrow('safely inspect')
    await writeFile(join(first, 'project_config.json'), project(1, '同名', [
      { character_id: 'char_1', name: 'bad\u202e role' },
    ]))
    await expect(projects.list(current)).rejects.toThrow('safely inspect')
    await writeFile(join(first, 'project_config.json'), project(1, '同名', [
      { character_id: 'char_1', name: '角色', asset_id: 0 },
    ]))
    await expect(projects.list(current)).rejects.toThrow('safely inspect')
    await writeFile(join(first, 'project_config.json'), project(1, '同名', [
      { character_id: 'char_1', name: '角色' },
    ]))
    message(current, '请使用项目 1')
    expect(await projects.select(current, 1)).toMatchObject({ characters: [
      { character_id: 'char_1', role_class: null },
    ] })
    await writeFile(join(workshop, 'ordinary-file.txt'), 'not a project')
    expect(await projects.list(current)).toHaveLength(2)
    const duplicate = join(workshop, 'third')
    await mkdir(duplicate)
    await writeFile(join(duplicate, 'project_config.json'), project(2, '同名'))
    expect((await projects.list(current)).map(row => row.script_id)).toEqual([1, 2, 2])
    message(current, '请使用项目 2')
    await expect(projects.select(current, 2)).rejects.toThrow('explicitly identify')
    await rm(duplicate, { recursive: true, force: true })
    const extra = Array.from({ length: 62 }, (_, index) => join(workshop, `extra-${index}`))
    await Promise.all(extra.map(path => mkdir(path)))
    await expect(projects.list(current)).rejects.toThrow('safely inspect')
    await Promise.all(extra.map(path => rm(path, { recursive: true, force: true })))
    const link = join(workshop, 'escape')
    await symlink(root, link, 'junction')
    await expect(projects.list(current)).rejects.toThrow('safely inspect')
    await rm(link)
    await rm(workshop, { recursive: true, force: true })
    await writeFile(workshop, 'not a directory')
    await expect(projects.list(current)).rejects.toThrow('safely inspect')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('bounds the complete valid project result to 64 roots', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-character-project-bound-')))
  const workshop = join(root, 'short-drama')
  const { projects, session } = fixture()
  try {
    await mkdir(workshop, { recursive: true })
    await writeFile(join(root, 'project_config.json'), project(1, '根项目'))
    const children = Array.from({ length: 64 }, (_, index) => join(workshop, `project-${index}`))
    await Promise.all(children.slice(0, 63).map(async (directory, index) => {
      await mkdir(directory)
      await writeFile(join(directory, 'project_config.json'), project(index + 2, `项目${index + 2}`))
    }))
    await expect(projects.list(session(root))).resolves.toHaveLength(64)
    await mkdir(children[63]!)
    await writeFile(join(children[63]!, 'project_config.json'), project(65, '项目65'))
    await expect(projects.list(session(root))).rejects.toThrow('safely inspect')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

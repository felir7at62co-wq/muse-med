/** Current video-to-screenplay guidance is available from both product Skill registries. */
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'
import * as CreationSkills from '../src/creation-skills.ts'

const productRoot = fileURLToPath(new URL('../skills/', import.meta.url))

it('forwards the maintained bundled video guide and its actual resources into creation', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFilesystem, { includeDefaultRoots: false, bundledSkillDir: productRoot, watch: false })
    const creation = ctx.isolate('skills')
    await creation.plugin(SkillRegistry)
    await creation.plugin(CreationSkills)
    expect(creation.skills).not.toBe(ctx.skills)
    const directory = join(productRoot, 'video-to-screenplay')
    const original = await ctx.skills.get('video-to-screenplay')
    expect(original).toBeDefined()
    expect(original?.source).toBe('bundled')
    expect(original?.resourceBase).toEqual({ kind: 'directory', path: directory })
    expect(original?.invocation).toMatchObject({ modelInvocable: true, userInvocable: true })
    expect((await ctx.skills.list()).filter(skill => skill.name === 'video-to-screenplay')).toHaveLength(1)
    expect((await creation.skills.list()).filter(skill => skill.name === 'video-to-screenplay')).toHaveLength(1)
    const forwarded = await creation.skills.get('video-to-screenplay')
    expect(forwarded).toMatchObject({ name: 'video-to-screenplay', provider: 'muse-creation', source: 'bundled',
      content: original!.content, path: original!.path, resourceBase: original!.resourceBase })
    for (const registry of [ctx.skills, creation.skills]) {
      expect(await registry.get('transcript-to-script')).toBeUndefined()
    }
    ctx.effect(() => ctx.skills.register({ name: 'unlisted-video-route', description: 'Unapproved bundled writing guide',
      source: 'bundled', content: 'Do not forward this bundled instruction.' }))
    expect(await ctx.skills.get('unlisted-video-route')).toBeDefined()
    expect(await creation.skills.get('unlisted-video-route')).toBeUndefined()
    const files = await readdir(directory, { recursive: true, withFileTypes: true })
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue
      const path = join(file.parentPath, file.name)
      const content = await readFile(path, 'utf8')
      expect(content.trim(), path).not.toBe('')
      for (const link of content.matchAll(/\]\(([^)]+)\)/gu)) {
        const target = link[1]
        if (target === undefined || /^(?:https?:|#)/u.test(target)) continue
        await expect(access(resolve(dirname(path), target.split('#')[0]!)), `${path}: ${target}`).resolves.toBeUndefined()
      }
    }
  } finally { await ctx.fiber.dispose() }
})

it('keeps whole-series transcription on a goal with subtitle OCR aligned to ASR', async () => {
  const directory = join(productRoot, 'video-to-screenplay')
  const entry = await readFile(join(directory, 'SKILL.md'), 'utf8')
  expect(entry).toMatch(/整部或多集转写.*这一轮调用 `create_goal`.*每轮集数.*唤醒的轮次不能再建目标/su)
  expect(entry).toMatch(/待定问题写进每批汇报后继续/u)
  expect(entry).toMatch(/`tool_search` 搜 `video_ocr`.*按时间与 ASR 对齐/su)
  expect(entry).toMatch(/`output_json` 的说话人分组/u)
  expect(entry).toMatch(/`video_inspect` 先 `scan`.*`observe` 逐帧记录.*`status` 显示 `complete`/su)
  expect(entry).toMatch(/▲行写看帧记录里实际看到的.*每集都要有/su)
  expect(entry).toMatch(/不补写原片没有的台词、动作或钩子/u)
  expect(entry).toMatch(/不用脚本把 ASR 批量套进模板/u)
  expect(entry).toMatch(/`source_mode: "video"`.*`video_dir`.*`screenplay_export_docx` 按集顺序导出 Word/su)
  expect(entry).toMatch(/用 `tool_search` 搜出来再调用.*不要自己写脚本替代或模拟这些工具.*程序会列出仍缺的整剧 Word/su)
  expect(entry).toMatch(/没跑 `video_ocr` 的集不称已按字幕校正/u)

  const workflow = await readFile(join(directory, 'references', 'video-workflow.md'), 'utf8')
  expect(workflow).toMatch(/`video_ocr`.*`next_start_seconds`.*`merged_text_path`.*`transcript\/ocr\/`/su)
  expect(workflow).toMatch(/按时间重叠把 OCR 字幕段对应到 ASR 段.*以清晰字幕为准.*说话人分组看 ASR/su)
  expect(workflow).toMatch(/`persistent_text_candidate`.*不当台词/su)
  expect(workflow).toMatch(/`output_json` 各段的 `start`、`end`、`speaker_id` 和 `text`.*字卡/su)
  expect(workflow).not.toContain('首次出场集')

  const series = workflow.slice(workflow.indexOf('## 多集整剧转写'), workflow.indexOf('## 从来源写成场景'))
  expect(series).toMatch(/同一轮调用 `create_goal`.*唤醒的轮次不能再创建目标/su)
  expect(series).toContain('不写每集必须补集尾钩子')
  expect(series).toMatch(/待定问题写进当批汇报.*不以只提问的回复结束/su)
  expect(series).toMatch(/返回 `silent` 时按可疑结果处理.*`video_ocr` 扫全集/su)
  expect(series).toMatch(/人物表与分段协作.*每批写完用 `grep`.*已交付的集另存新版本/su)
  expect(series).toMatch(/`【下集钩子】` 只标在原片已有的悬念前.*不新增没有画面依据的 ▲/su)
  expect(series).toMatch(/每批汇报只写实际做过的核对.*`scan_status`.*`silent`/su)
  expect(series).toMatch(/每批写完，用 `manuscript_revision` 的 `transcript_coverage` 逐集比对.*不代替 `source_fidelity`.*照录各集 `summary`/su)

  const ocrTool = await readFile(fileURLToPath(new URL('../../../packages/perception/tool-video-inspect/src/ocr.ts', import.meta.url)), 'utf8')
  for (const field of ['next_start_seconds', 'raw_json_path', 'merged_text_path', 'scan_status', 'persistent_text_candidate']) {
    expect(ocrTool).toContain(field)
  }
})

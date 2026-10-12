import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assetRow, call, cleanup, manifestDocument, speakingShot, tempDir } from './harness.ts'

describe('source-scene context through the real compiler', () => {
  it('keeps leading and changed scene context in every package without changing the script or binding the cast list', async () => {
    const root = await tempDir()
    try {
      const script = [
        '场次对照：54-1 后厨 夜 内；54-2 办公室 次日清晨 内',
        '场次54-1：后厨 夜 内｜原文出场人物：苏晚、陆沉',
        speakingShot(1, '苏晚：别走', ['核心场景：后厨', '时长：9秒']),
        speakingShot(2, '苏晚：等等', ['核心场景：后厨', '时长：9秒']),
        '场次54-2：办公室 次日清晨 内｜原文出场人物：苏晚、陆沉',
        speakingShot(3, '苏晚：外面有人', ['核心场景：办公室窗下外墙', '时长：9秒']),
        speakingShot(4, '苏晚：他回来了', ['核心场景：办公室', '时长：9秒']),
        '场次54-3：门口 次日清晨 外',
        speakingShot(5, '苏晚：回家吧', ['核心场景：门口', '时长：9秒']),
      ].join('\n')
      const assets = manifestDocument(
        assetRow('苏晚', '角色'), assetRow('陆沉', '角色', { jubian_asset_id: '71001' }),
        ...['后厨', '办公室窗下外墙', '办公室', '门口'].map((name, index) =>
          assetRow(name, '场景', { jubian_asset_id: String(72001 + index) })),
      )
      await writeFile(join(root, 'shots.txt'), script)
      await writeFile(join(root, 'assets.json'), JSON.stringify(assets))
      await mkdir(join(root, 'episodes'))
      await writeFile(join(root, 'episodes/01.txt'), '第01集\n苏晚：别走\n')
      const result = await call({ method: 'compile', script: join(root, 'shots.txt'), assets: join(root, 'assets.json'),
        project: root, episode: 1, max_submit_seconds: 15 })
      expect(result.ok).toBe(true)
      expect(result.packages.map(pack => pack.shots)).toEqual([[1], [2], [3], [4], [5]])
      expect(result.shots.map(item => item.text)).toEqual(['别走', '等等', '外面有人', '他回来了', '回家吧'])
      expect(result.shots.every(item => !item.bindings.some(asset => asset.name === '陆沉'))).toBe(true)
      expect(result.packages.slice(0, 2).every(pack => pack.prompt.includes('场次54-1：后厨 夜 内；'))).toBe(true)
      expect(result.packages[1]?.prompt).not.toContain('场次54-2')
      expect(result.packages[2]?.prompt).toContain('场次54-2：办公室 次日清晨 内；本镜可为内外插镜')
      expect(result.shots[2]?.bindings.filter(asset => asset.type === '场景').map(asset => asset.name)).toEqual(['办公室窗下外墙'])
      expect(result.packages[3]?.prompt).not.toContain('场次54-3')
      expect(result.packages[4]?.prompt).toContain('场次54-3：门口 次日清晨 外；')
      expect(result.packages.every(pack => !pack.prompt.includes('场次对照') && !pack.prompt.includes('时长：'))).toBe(true)
      expect(await readFile(join(root, 'episode_packages/01/shot_script.txt'), 'utf8')).toBe(script)
      expect(await readFile(join(root, 'shots.txt'), 'utf8')).toBe(script)
    } finally {
      await cleanup(root)
    }
  })

  it('keeps a registered scene, person and prop mentioned only in source context out of asset selection', async () => {
    const root = await tempDir()
    try {
      const script = [
        '场次54-1：陆沉家 夜 内 奶瓶｜原文出场人物：陆沉',
        '真人短剧写实风格', '【镜头1】', '景别：特写',
        '运镜：相机固定，白色墙面的光影变化', '发声类型：action',
      ].join('\n')
      const assets = manifestDocument(assetRow('陆沉', '角色'), assetRow('陆沉家', '场景'), assetRow('奶瓶', '道具'))
      await writeFile(join(root, 'shots.txt'), script)
      await writeFile(join(root, 'assets.json'), JSON.stringify(assets))
      const result = await call({ method: 'preview', script: join(root, 'shots.txt'), assets: join(root, 'assets.json'),
        project: root, episode: 1, max_submit_seconds: 15 })
      expect(result.ok).toBe(true)
      expect(result.shots[0]?.bindings).toEqual([])
      expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'no_scene_bound', shot: 1 })]))
      expect(result.packages[0]?.material_bindings).toEqual([])
      expect(result.packages[0]?.prompt).toContain('来源场次（原文段落）：场次54-1：陆沉家 夜 内 奶瓶；')
    } finally {
      await cleanup(root)
    }
  })
})

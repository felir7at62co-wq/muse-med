/** Real Loader inventory acquisition keeps complete native cards below the unchanged transport cap. */
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ProductionConfig } from '../src/production.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { sessionVideoShot } from './fixtures/session-video.ts'
import { actionShot, cleanup, tempDir } from './harness.ts'

const disposers: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
})

const responseCap = 2 * 1024 * 1024
const directorPrompt = [
  '镜头一：清晨古玩街入口，固定中景。苏晚穿白色衬衫从画面左侧进入，双手自然垂下，在木桌前停稳。摊主保持原来的灰色外套与白发造型，站在桌子另一侧。只建立双方位置，人物不说话，不提前拿起道具。光线从右前方进入，远处行人保持虚焦。',
  '镜头二：切苏晚的过肩视角，青铜器完整放在桌子中央，器身纹路、底座与上一镜一致。摊主用右手指向器身侧面的刻纹，不遮住刻纹，也不转动器物。苏晚顺着指向低头观察。镜头缓慢推进，只出现一件青铜器，不增加宝石或其他商品。',
  '镜头三：苏晚面部近景，保持眼镜、发型、衬衫领口与上一镜一致。她先看器物再抬眼看向摊主，面部正对对方，嘴部随台词自然开合。台词为“这里的纹路不是原来的”。背景保留左侧的木架，听者不同时开口，不加入旁白和屏幕文字。',
  '镜头四：反打摊主肩部以上近景，白发和灰色外套不变，视线朝向画面左侧的苏晚。摊主听完后短暂停顿，再低声回答“你再仔细看看”。镜头保持稳定，不突然更换背景或服装，不让听者抢说台词。末尾保留自然呼吸，避免提前切断最后一个字。',
  '镜头五：俯拍双手与青铜器。苏晚只用戴白手套的右手轻触器身外侧，左手扶住底部，器物未被打开或切割。镜头完整保留器口与底座，动作从接触到收手连贯，不穿过实体，不出现多余手指。桌面原有布料纹理与前镜保持一致。',
  '镜头六：回到双人中景，苏晚收回双手，仍站在原位。摊主退后半步并观察她的表情，两人没有交换站位，也没有第三位同样面孔的人进入。运镜只做轻微推近，接点继承器物未移动状态。环境音保持街道远处人声，不加入突然响起的背景音乐。',
  '镜头七：苏晚侧面近景，她看向器物边缘后转头看摊主，语气平静但明确。台词为“我已经看清楚了”。保持音色与前文一致，实际说话者开口，听者闭口。不要在画面直接生成字幕、价格标签、水印或界面文字，台词也不额外补充新情节。',
  '镜头八：摊主反应中景，先看苏晚，再低头看仍在桌面原位的青铜器，表情从迟疑转为认真。固定镜头自然结束，不增加器物损坏、流血、打斗或夸张动作。人物、光线、服装与前镜连续，完整保留动作收尾，为下一段对话留出正常切换位置。',
].join('\n')

async function fixture(config: Pick<ProductionConfig, 'pageSize' | 'pageLimit'> = {}, oversizedCard = false) {
  const root = await tempDir(); disposers.push(() => cleanup(root))
  const catalogue: unknown = JSON.parse(await readFile(new URL('../../../jubian/jubian-api/tests/fixtures/catalogue-20261016.json', import.meta.url), 'utf8'))
  if (!catalogue || typeof catalogue !== 'object' || !('1' in catalogue)) throw new Error('Missing fixture model catalogue')
  const prompt = oversizedCard ? directorPrompt.repeat(Math.ceil(responseCap / Buffer.byteLength(directorPrompt)) + 1) : directorPrompt
  const cards = Array.from({ length: oversizedCard ? 1 : 1000 }, (_, index) => ({ id: 70000 + index,
    scriptId: 4908, episodeId: 102505, episodeCount: 1, storyboardName: `已有完整分包${index + 1}`,
    sortOrder: index + 1, isGenerate: 0, storyboardMaterialList: [],
    modelConfig: JSON.stringify({ modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU',
      ratio: '9:16', resolution: '480p', duration: 25, genNum: 1, prompt, materialList: [] }),
  }))
  const envelope = (data: unknown) => JSON.stringify({ code: 200, data })
  const legacyPageBytes = Buffer.byteLength(envelope({ total: cards.length, rows: cards }))
  const calls: Array<{ method: string; path: string }> = []
  const pages: Array<{ page: number; size: number; ids: number[]; bytes: number }> = []
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const address = new URL(input instanceof Request ? input.url : String(input)), method = init?.method ?? 'GET'
    calls.push({ method, path: address.pathname })
    if (address.hostname !== 'inventory.invalid' || method !== 'GET') throw new Error('Unexpected inventory provider request')
    let data: unknown
    if (address.pathname === '/model/charge/getSelectList') data = catalogue['1']
    else if (address.pathname === '/aigc/script/4908') data = { id: 4908, scriptName: 'Large inventory fixture' }
    else if (address.pathname === '/aigc/episode/list') data = { total: 1, rows: [{ id: 102505, scriptId: 4908, episodeCount: 1 }] }
    else if (address.pathname === '/aigc/asset/list' || address.pathname === '/aigc/material/list') data = { total: 0, rows: [] }
    else if (address.pathname === '/aigc/storyboard/list') {
      const page = Number(address.searchParams.get('pageNum')), size = Number(address.searchParams.get('pageSize'))
      const rows = cards.slice((page - 1) * size, page * size)
      data = { total: cards.length, rows }
      pages.push({ page, size, ids: rows.map(row => row.id), bytes: Buffer.byteLength(envelope(data)) })
    } else if (/^\/aigc\/storyboard\/\d+$/u.test(address.pathname)) {
      data = cards.find(row => row.id === Number(address.pathname.split('/').at(-1)))
    } else throw new Error(`Unexpected inventory route: ${address.pathname}`)
    return new Response(envelope(data))
  })
  disposers.push(async () => { transport.mockRestore() })
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 4908 }))
  const script = join(root, 'shots.txt'); await writeFile(script, actionShot(1, ['时长：4秒']))
  const loaded = await sessionVideoShot(root, { reviewMode: 'advisory', sessionVideoSelection: true, productionPackaging: true,
    production: { baseUrl: 'https://inventory.invalid', workspaceSecrets: false, ledgerRoot: join(root, 'ledger'), ...config } })
  disposers.push(loaded.dispose)
  await loaded.ctx.plugin(MemoryCredentials, { JUBIANAI_ADMIN_TOKEN: 'offline-inventory-fixture' })
  const agent = await loaded.create('production-inventory')
  const target = cards.at(-1)!.id
  const preview = () => executeModelToolFixture(loaded.ctx, { agent, name: 'muse_production', callId: ToolCallId('inventory-preview'),
    signal: new AbortController().signal, arguments: { method: 'preview', project_dir: root, script, episode: 1,
      ratio: '9:16', gen_type: 3, targets: [{ index: 1, storyboard_id: target }] } })
  return { root, calls, pages, target, preview, legacyPageBytes }
}

async function expectReadOnly(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.calls.filter(call => call.method !== 'GET')).toEqual([])
  await expect(readFile(join(f.root, 'episode_packages', '01', 'package.json'))).rejects.toThrow()
}

it('uses twenty bounded default pages to read all 1000 complete cards and verify a final-page target', async () => {
  const f = await fixture(), result = await f.preview()
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('Missing preview result')
  const report = z.object({ plan_path: z.string(), paid_requests: z.literal(0),
    package_index: z.array(z.object({ storyboard_id: z.number(), target_candidates: z.array(z.number()) })) }).parse(JSON.parse(block.text))
  expect(report.package_index).toEqual([{ storyboard_id: f.target, target_candidates: [f.target] }])
  expect(f.legacyPageBytes).toBeGreaterThan(responseCap)
  expect(f.pages.map(page => page.page)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
  expect(f.pages.every(page => page.size === 50 && page.bytes < responseCap)).toBe(true)
  expect(f.pages.flatMap(page => page.ids)).toEqual(Array.from({ length: 1000 }, (_, index) => 70000 + index))
  expect(f.calls).toContainEqual({ method: 'GET', path: `/aigc/storyboard/${f.target}` })
  const plan = z.object({ packages: z.array(z.object({ storyboard_id: z.number(),
    expected_snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/u) })) }).parse(JSON.parse(await readFile(report.plan_path, 'utf8')))
  expect(plan.packages[0]?.storyboard_id).toBe(f.target)
  await expectReadOnly(f)
})

it('still rejects the same complete inventory when explicitly requested in one oversized 1000-row page', async () => {
  const f = await fixture({ pageSize: 1000 }), result = await f.preview()
  expect(result.isError).toBe(true)
  expect(f.pages).toHaveLength(1)
  expect(f.pages[0]?.bytes).toBeGreaterThan(responseCap)
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('Missing oversized response error')
  expect(block.text).toContain('2097152-byte cap')
  await expectReadOnly(f)
})

it('keeps the byte cap when a single native card itself is oversized', async () => {
  const f = await fixture({}, true), result = await f.preview()
  expect(result.isError).toBe(true)
  expect(f.pages).toHaveLength(1)
  expect(f.pages[0]).toMatchObject({ size: 50, ids: [70000] })
  expect(f.pages[0]?.bytes).toBeGreaterThan(responseCap)
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('Missing oversized card error')
  expect(block.text).toContain('2097152-byte cap')
  await expectReadOnly(f)
})

it('refuses an incomplete inventory at the configured page limit instead of using the first pages', async () => {
  const f = await fixture({ pageLimit: 2 }), result = await f.preview()
  expect(result.isError).toBe(true)
  expect(f.pages.map(page => page.page)).toEqual([1, 2])
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('Missing incomplete inventory error')
  expect(block.text).toContain('page limit or is incomplete')
  expect(f.calls.some(call => call.path === `/aigc/storyboard/${f.target}`)).toBe(false)
  await expectReadOnly(f)
})

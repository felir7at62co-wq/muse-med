/**
 * Fixtures shared by this package's specs: the director-format shot builders, the
 * asset-manifest builders, and the stub registry the plugin mounts against.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** The fixed negative prompt the director format requires on every shot. */
export const NEGATIVE_PROMPT = '无噪点，无跳帧，五官稳定不变形'

/** One shot block: the style line, the marker, the body lines, and the negative prompt. */
export function shot(number: number, lines: readonly string[]): string {
  return ['真人短剧写实风格', `【镜头${number}】`, ...lines, NEGATIVE_PROMPT].join('\n')
}

/** One director-format speaking shot with every field the format expects. */
export function speakingShot(number: number, dialogue = '苏晚：宝宝……那是我的宝宝！',
  extra: readonly string[] = []): string {
  return shot(number, [
    '景别：近景',
    '运镜：相机固定，苏晚站在后厨水池前看向画外',
    '视角：相机视角平视',
    '主体状态追踪：',
    '【苏晚】-位置：【场景图视角后厨左侧洗碗池前靠近柜门处】；',
    '动作状态：【双手撑着台面，肩膀发抖】；',
    '四层朝向链：【身体朝向画外方向，面部朝向那里，目光固定，眼神发紧】；',
    '手部状态：【双手撑在台面】，【无】；',
    '情绪状态：【眼周泛红，呼吸急促】；',
    `台词：${dialogue}`,
    ...extra,
  ])
}

/** One director-format silent action shot. */
export function actionShot(number: number, extra: readonly string[] = []): string {
  return shot(number, [
    '景别：全景',
    '运镜：相机固定，苏晚快步穿过客厅走向楼梯',
    '视角：相机视角平视',
    '主体状态追踪：',
    '【苏晚】-位置：【场景图视角客厅中央靠近楼梯口处】；',
    '动作状态：【快步穿过客厅】；',
    '四层朝向链：【身体朝向楼梯方向，面部朝向那里，目光固定，眼神着急】；',
    '手部状态：【双手提着裙摆】，【无】；',
    '情绪状态：【眉头紧锁】；',
    '发声类型：action',
    ...extra,
  ])
}

/** Join shot blocks into one script exactly as the format lays them out. */
export function scriptOf(...blocks: readonly string[]): string {
  return blocks.join('\n')
}

/** One asset-manifest row that passes every binding rule unless overridden. */
export function assetRow(name: string, type: string, overrides: Record<string, unknown> = {}):
Record<string, unknown> {
  return {
    name,
    type,
    id: `id-${name}`,
    official: true,
    jubian_asset_id: '70001',
    jubian_material_id: '80001',
    url: 'https://cdn.example.test/asset.png',
    image_path: '',
    ...overrides,
  }
}

/** One asset-manifest document. */
export function manifestDocument(...rows: readonly Record<string, unknown>[]): { assets: unknown[] } {
  return { assets: [...rows] }
}

/**
 * The registered `drama_shot` definition as these specs drive it.
 *
 * The tool body reads only its arguments, and `dsh-tools` mints `ToolRunContext.token`
 * inside the registry with no exported constructor, so `execute` takes the one argument
 * the body reads.
 */
export type RegisteredShot = Omit<ToolDefinition, 'execute'> & {
  execute(args: unknown): Promise<unknown>
}

/** Mount the plugin against a stub tool registry and return what it registered. */
export function mount(config: Config = {}): RegisteredShot[] {
  const registered: RegisteredShot[] = []
  const ctx = {
    tools: {
      register: (definition: RegisteredShot) => {
        registered.push(definition)
        return () => {}
      },
    },
  } as unknown as Context
  apply(ctx, config)
  return registered
}

/** The one `drama_shot` definition this package registers. */
export function dramaShot(): RegisteredShot {
  const tool = mount().find(candidate => candidate.name === 'drama_shot')
  if (tool === undefined) throw new Error('drama_shot was not registered')
  return tool
}

/** Run one `drama_shot` call through the registered definition. */
export async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await dramaShot().execute(args) as Record<string, unknown>
}

/** Create a temporary directory the caller removes. */
export async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'drama-shot-'))
}

/** Remove a temporary directory tree, ignoring an already-removed tree. */
export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

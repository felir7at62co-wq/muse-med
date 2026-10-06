/** Download tools belong to each creative preset and disappear with its scope. */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as yaml from 'js-yaml'
import { expect, it } from 'vitest'
import * as Hongguo from '../../../third_party/plugins/muse-hongguo-download/src/index.js'
import * as Douyin from '../../../third_party/plugins/muse-douyin-download/src/index.js'
import * as Reverse from '../../../third_party/plugins/muse-reverse-tools/src/index.js'
import * as Fanqie from '../../../third_party/plugins/muse-fanqie-download/src/index.js'

const expressionTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: (value: string) => ({ __jsExpr: value }),
})
const schema = yaml.DEFAULT_SCHEMA.extend([expressionTag])

interface PresetRow {
  readonly id?: string
  readonly name?: string
  readonly config?: Record<string, unknown>
}

it('bundles one original-source runtime configuration under the standalone patch config', () => {
  const patch = yaml.load(readFileSync(new URL('../../../third_party/plugins/muse-hongguo-download/cordis.patch.yml', import.meta.url), 'utf8'), { schema }) as { insert: PresetRow[] }[]
  expect(patch).toHaveLength(1)
  expect(patch[0]?.insert).toHaveLength(1)
  const row = patch[0]?.insert[0]
  expect(row?.config?.javaExecutable).toEqual({ __jsExpr: "process.env.MUSE_HONGGUO_JAVA_PATH || ''" })
  expect(row?.config?.bootstrapDevices).toEqual({ __jsExpr: "process.env.MUSE_HONGGUO_BOOTSTRAP_DEVICES === '1'" })
  expect(Object.keys(row ?? {}).sort()).toEqual(['config', 'id', 'name'])
})

it('registers local analysis and download tools in creative scopes and leaves minimal and global scopes empty', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SubprocessLocal)
    for (const preset of ['standard', 'ptc', 'cordis', 'short-drama', 'editing', 'minimal']) {
      const rows = yaml.load(readFileSync(new URL(`../../desktop-host/presets/${preset}/agent.cordis.yml`, import.meta.url), 'utf8'), { schema }) as PresetRow[]
      const hongguo = rows.find(row => row.id === 'muse-hongguo-download')
      const douyin = rows.find(row => row.id === 'muse-douyin-download')
      const reverse = rows.find(row => row.id === 'muse-reverse-tools')
      const fanqie = rows.find(row => row.id === 'muse-fanqie-download')
      const key = {}
      const scope = createScope(ctx, key)
      try {
        if (preset === 'minimal') {
          expect(hongguo).toBeUndefined()
          expect(douyin).toBeUndefined()
          expect(reverse).toBeUndefined()
          expect(fanqie).toBeUndefined()
        } else {
          expect(hongguo?.name, preset).toBe('muse-hongguo-download')
          expect(hongguo?.config?.sourceMode, preset).toBe('legacy')
          expect(hongguo?.config?.signTokenEnv, preset).toBe('MUSE_HONGGUO_SIGN_TOKEN')
          expect(hongguo?.config?.javaExecutable, preset).toEqual({ __jsExpr: "process.env.MUSE_HONGGUO_JAVA_PATH || ''" })
          expect(hongguo?.config?.bootstrapDevices, preset).toEqual({ __jsExpr: "process.env.MUSE_HONGGUO_BOOTSTRAP_DEVICES === '1'" })
          expect(douyin?.name, preset).toBe('muse-douyin-download')
          expect(douyin?.config?.pythonExecutable, preset).toEqual({ __jsExpr: 'process.env.MUSE_DOUYIN_PYTHON_PATH || null' })
          expect(douyin?.config?.ffmpegExecutable, preset).toEqual({ __jsExpr: 'process.env.DSH_FFMPEG_PATH || process.env.FFMPEG_PATH || null' })
          expect(douyin?.config?.ffprobeExecutable, preset).toEqual({ __jsExpr: 'process.env.DSH_FFPROBE_PATH || process.env.FFPROBE_PATH || null' })
          expect(reverse?.name, preset).toBe('muse-reverse-tools')
          expect(fanqie?.name, preset).toBe('muse-fanqie-download')
          expect(fanqie?.config?.pythonExecutable, preset).toEqual({ __jsExpr: "process.env.MUSE_FANQIE_PYTHON_PATH || process.env.MUSE_HONGGUO_PYTHON_PATH || ''" })
          await scope.ctx.plugin(Hongguo, { sourceMode: 'legacy', signTokenEnv: 'MUSE_HONGGUO_SIGN_TOKEN' })
          await scope.ctx.plugin(Douyin)
          await scope.ctx.plugin(Reverse)
          await scope.ctx.plugin(Fanqie)
        }
        expect(ctx.tools.schemas(key).map(tool => tool.name), preset).toEqual(preset === 'minimal' ? [] : [
          'hongguo_download_info', 'hongguo_download', 'douyin_download',
          'reverse_skill', 'reverse_analyze', 'fanqie_download_info', 'fanqie_download',
        ])
        expect(ctx.tools.schemas()).toEqual([])
      } finally {
        await scope.dispose()
      }
      expect(ctx.tools.schemas(key)).toEqual([])
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

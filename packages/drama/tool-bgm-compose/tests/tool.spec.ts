/** Model-facing tool identity, schema, and configuration. */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply, Config, inject, name } from '../src/index.ts'

function mount(config: Config = {}): ToolDefinition {
  const registered: ToolDefinition[] = []
  apply(Object.assign(new Context(), {
    subprocess: {},
    tools: { register: (tool: ToolDefinition) => { registered.push(tool); return () => {} } },
  }), config)
  const tool = registered.find(candidate => candidate.name === 'drama_bgm')
  if (tool === undefined) throw new Error('drama_bgm was not registered')
  return tool
}

describe('registration', () => {
  it('declares the tool and subprocess services it requires', () => {
    expect(name).toBe('tool-bgm-compose')
    expect(inject).toEqual(['tools', 'subprocess'])
  })

  it('registers preview, compose, and verify without claiming to choose music', () => {
    const tool = mount()
    expect(tool.description).toContain('不选曲')
    expect(tool.description).toContain('bgm_match')
    expect(tool.description).toContain('m-a-p/MERT-v1-95M')
    expect(tool.description).toContain('CC-BY-NC-4.0')
    expect(tool.description).toContain('仅限非商业用途')
    expect(tool.description).toContain('drama_render.bgm')
    const parameters = tool.parameters as {
      properties: Record<string, { enum?: string[]; description?: string }>
      required: string[]
    }
    expect(Object.keys(parameters.properties).sort()).toEqual(['episode', 'method', 'output', 'plan', 'project', 'timeline'])
    expect(parameters.properties.method?.enum).toEqual(['preview', 'compose', 'verify'])
    expect(parameters.properties.plan?.description).toContain('write 返回的绝对 path')
    expect(parameters.properties.timeline?.description).toContain('相对路径以 project 为基准')
    expect(parameters.properties.output?.description).toContain('相对路径以 project 为基准')
    expect(parameters.required.sort()).toEqual(['episode', 'method', 'plan', 'project', 'timeline'])
  })

  it('matches the recorded-session owner schema generated through the shipped Loader', async () => {
    const snapshot = JSON.parse(await readFile(new URL(
      '../../../../snapshots/session/drama-bgm-preview/tool-schemas.expected.json', import.meta.url,
    ), 'utf8')) as { initial: { name: string; description: string; parameters: unknown }[] }
    const tool = mount()
    expect({ name: tool.name, description: tool.description, parameters: tool.parameters })
      .toEqual(snapshot.initial.find(row => row.name === 'drama_bgm'))
  })

  it('declares its canonical report fields and renders pretty JSON', () => {
    const tool = mount()
    const output = tool.output.schema as { properties: Record<string, unknown> }
    expect(Object.keys(output.properties).sort()).toEqual([
      'batch_episodes', 'body_duration_seconds', 'crossfade_seconds', 'decision_reason', 'episode', 'intended_use', 'license_records',
      'media', 'method', 'music_decision', 'output', 'plan', 'policy_findings', 'preview_notice', 'project', 'repeated_sequence_episodes', 'report', 'segments', 'status', 'timeline',
    ])
    expect(validateJsonSchemaValue(tool.parameters, {
      method: 'compose', project: 'D:/project', episode: 5,
      timeline: 'editing/05-timeline.json', plan: 'editing/bgm-plan.json',
    }, '')).toEqual([])
    const blocks = tool.output.render({}, { method: 'preview' }) as { type: string; text: string }[]
    expect(blocks).toEqual([{ type: 'text', text: '{\n  "method": "preview"\n}' }])
  })
})

describe('Config', () => {
  it('defaults every deployment-varying process setting and batch limit', () => {
    expect(Config({})).toEqual({
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', commandTimeoutMs: 300_000,
      terminationGraceMs: 5_000, outputMaxBytes: 1_048_576,
      minTracksPerEpisode: 1, maxEpisodesPerTrack: 2, freshTracksPerEpisode: 0,
      boundaryToleranceSeconds: 0.05,
    })
  })

  it('rejects invalid command limits', () => {
    expect(() => Config({ commandTimeoutMs: 0 })).toThrow()
    expect(() => Config({ outputMaxBytes: 0 })).toThrow()
    expect(() => Config({ minTracksPerEpisode: 0 })).toThrow()
  })
})

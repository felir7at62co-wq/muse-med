/** Model-facing tool identity, schema, and configuration. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply, Config, inject, name } from '../src/index.ts'

function mount(config: Config = {}): ToolDefinition {
  const registered: ToolDefinition[] = []
  apply({
    subprocess: {},
    tools: { register: (tool: ToolDefinition) => { registered.push(tool); return () => {} } },
  } as unknown as Context, config)
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
    const parameters = tool.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] }
    expect(Object.keys(parameters.properties).sort()).toEqual(['episode', 'method', 'output', 'plan', 'project', 'timeline'])
    expect(parameters.properties.method?.enum).toEqual(['preview', 'compose', 'verify'])
    expect(parameters.required.sort()).toEqual(['episode', 'method', 'plan', 'project', 'timeline'])
  })

  it('declares its canonical report fields and renders pretty JSON', () => {
    const tool = mount()
    const output = tool.output.schema as { properties: Record<string, unknown> }
    expect(Object.keys(output.properties).sort()).toEqual([
      'body_duration_seconds', 'crossfade_seconds', 'episode', 'media', 'method', 'output', 'plan',
      'project', 'repeated_sequence_episodes', 'report', 'segments', 'timeline',
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
  it('defaults every deployment-varying process setting', () => {
    expect(Config({})).toEqual({
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', commandTimeoutMs: 300_000,
      terminationGraceMs: 5_000, outputMaxBytes: 1_048_576,
    })
  })

  it('rejects invalid command limits', () => {
    expect(() => Config({ commandTimeoutMs: 0 })).toThrow()
    expect(() => Config({ outputMaxBytes: 0 })).toThrow()
  })
})

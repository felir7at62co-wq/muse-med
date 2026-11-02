/** Capability browsing reflects authorized tools and configured category order. */
import { describe, expect, it } from 'vitest'
import { capabilityMemberships, capabilitySummaries, discoverableCapabilities } from '../src/capabilities.ts'
import type { CapabilityDefinition } from '../src/capabilities.ts'

const definitions: CapabilityDefinition[] = [
  { id: 'video', title: '视频理解', description: '查看画面与识别声音', tools: ['video_*', 'audio_transcribe'] },
  { id: 'writing', title: '剧本写作', description: '整理剧本与导出文档', tools: ['drama_shot', 'export_word'] },
  { id: 'shared', title: '素材检查', description: '核对视频与稿件', tools: ['video_inspect', 'drama_shot'] },
  { id: 'private', title: '后台管理', description: '管理服务', tools: ['secret_*'] },
]

describe('authorized capability categories', () => {
  it('lists only nonempty authorized categories in configured order', () => {
    expect(capabilitySummaries(definitions, ['export_word', 'video_inspect', 'video_ocr', 'audio_transcribe']))
      .toEqual([
        { id: 'video', title: '视频理解', description: '查看画面与识别声音', tool_count: 3 },
        { id: 'writing', title: '剧本写作', description: '整理剧本与导出文档', tool_count: 1 },
        { id: 'shared', title: '素材检查', description: '核对视频与稿件', tool_count: 1 },
      ])
  })

  it('matches exact names and trailing prefixes without matching name substrings', () => {
    expect(capabilityMemberships('video_inspect', definitions)).toEqual(['video', 'shared'])
    expect(capabilityMemberships('drama_shot', definitions)).toEqual(['writing', 'shared'])
    expect(capabilityMemberships('audio_transcribe', definitions)).toEqual(['video'])
    expect(capabilityMemberships('my_video_inspect', definitions)).toEqual([])
    expect(capabilityMemberships('audio_transcribe_extra', definitions)).toEqual([])
  })

  it('counts one tool once even when multiple category patterns match it', () => {
    const overlapping = [{ id: 'all', title: 'All', description: '', tools: ['video_*', 'video_inspect', '*'] }]
    expect(capabilitySummaries(overlapping, ['video_inspect', 'read'])).toEqual([
      { id: 'all', title: 'All', description: '', tool_count: 2 },
    ])
    expect(capabilityMemberships('video_inspect', overlapping)).toEqual(['all'])
  })

  it('returns empty categories and memberships without leaking configured private groups', () => {
    expect(capabilitySummaries(definitions, [])).toEqual([])
    expect(capabilitySummaries(definitions, ['unclassified'])).toEqual([])
    expect(capabilitySummaries([], ['read'])).toEqual([])
    expect(capabilityMemberships('read', [])).toEqual([])
    expect(capabilityMemberships('unclassified', definitions)).toEqual([])
  })

  it('adds unassigned authorized deferred tools to a browsable category', () => {
    const names = ['video_inspect', 'late_mcp', 'base_read']
    const groups = discoverableCapabilities(definitions, names, new Set(['base_read']))
    expect(capabilitySummaries(groups, names).at(-1)).toEqual({ id: 'uncategorized', title: 'Other authorized tools',
      description: 'Browse authorized tools not assigned to another capability.', tool_count: 1 })
    expect(capabilityMemberships('late_mcp', groups)).toEqual(['uncategorized'])
    expect(capabilityMemberships('base_read', groups)).toEqual([])
    expect(capabilityMemberships('secret_delete', groups)).toEqual(['private'])
  })

  it('omits the fallback category when every authorized deferred tool is classified', () => {
    expect(discoverableCapabilities(definitions, ['base_read', 'video_inspect'], new Set(['base_read'])))
      .toBe(definitions)
    expect(discoverableCapabilities([], [], new Set())).toEqual([])
  })
})

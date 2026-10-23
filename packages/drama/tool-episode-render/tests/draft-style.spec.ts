/** Editor-unit typography stays independent from formal-render pixel styling. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parseTimelineDelivery, readProjectDelivery, resolveDeliveryPolicy } from '../src/delivery-policy.ts'
import { DEFAULT_DELIVERY } from '../src/delivery.ts'
import { appendClips, formatTimelineDocument, parseTimelineDocument } from '../src/timeline.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const style = { watermark: { font_size_ui: 7 },
  subtitle: { font_family: '山海经', font_size_ui: 11, border_width_ui: 20, transform_y: -0.465625 } }
async function project(draftStyle: object): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'draft-style-'))
  roots.push(root)
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ project_bible: {
    visual_medium: 'animation_3d', delivery: { draft_style: draftStyle },
  } }))
  return root
}

it('round trips explicit editor units without adding formal subtitle settings', async () => {
  const delivery = await readProjectDelivery(await project(style))
  expect(delivery).toEqual({ ...DEFAULT_DELIVERY, visual_medium: 'animation_3d', draft_style: style })
  expect(parseTimelineDocument(JSON.parse(formatTimelineDocument({ ...appendClips([1_000_000]), delivery })), 'timeline').delivery)
    .toEqual(delivery)
  expect(delivery).not.toHaveProperty('subtitle')
})

it('selects the whole saved draft style, including empty sections, without filling from the project', async () => {
  const root = await project(style)
  expect((await resolveDeliveryPolicy(root, DEFAULT_DELIVERY)).delivery).toMatchObject({ draft_style: style })
  for (const saved of [{}, { subtitle: {} }, { subtitle: { font_size_ui: 12 } }]) {
    const snapshot = parseTimelineDelivery({ ...DEFAULT_DELIVERY, draft_style: saved }, 'timeline')
    const policy = await resolveDeliveryPolicy(root, snapshot)
    expect(policy.delivery).toEqual({ ...snapshot, visual_medium: 'animation_3d' })
    expect(policy).toMatchObject({ addWatermark: false, endingSeconds: 0 })
  }
})

it('preserves inclusive UI bounds and trims a font name without resolving availability', () => {
  expect(parseTimelineDelivery({ ...DEFAULT_DELIVERY, draft_style: { watermark: {} } }, 'timeline').draft_style)
    .toEqual({ watermark: {} })
  expect(parseTimelineDelivery({ ...DEFAULT_DELIVERY, draft_style: { watermark: { font_size_ui: 100 },
    subtitle: { font_family: ' 山海经 ', font_size_ui: 0.01, border_width_ui: 0, transform_y: -1 } } }, 'timeline'))
    .toMatchObject({ draft_style: { watermark: { font_size_ui: 100 },
      subtitle: { font_family: '山海经', font_size_ui: 0.01, border_width_ui: 0, transform_y: -1 } } })
  expect(parseTimelineDelivery({ ...DEFAULT_DELIVERY, draft_style: {
    subtitle: { border_width_ui: 100, transform_y: 1 } } }, 'timeline').draft_style)
    .toEqual({ subtitle: { border_width_ui: 100, transform_y: 1 } })
})

it.each([null, [], 'style', { watermark: null }, { watermark: [] }, { subtitle: null }, { subtitle: [] },
  { watermark: { font_size_ui: 0 } }, { watermark: { font_size_ui: 101 } },
  { subtitle: { font_size_ui: '11' } }, { subtitle: { font_size_ui: NaN } },
  { subtitle: { font_size_ui: Infinity } }, { subtitle: { font_size_ui: -1 } },
  { subtitle: { border_width_ui: -1 } }, { subtitle: { border_width_ui: 101 } },
  { subtitle: { border_width_ui: null } }, { subtitle: { transform_y: -1.1 } },
  { subtitle: { transform_y: 1.1 } }, { subtitle: { transform_y: true } },
  { subtitle: { font_family: null } }, { subtitle: { font_family: '' } },
  { subtitle: { font_family: ' ' } }, { subtitle: { font_family: 'a'.repeat(129) } },
  { subtitle: { font_family: 'line\nbreak' } }, { subtitle: { font_family: 'control\u0085' } },
].map(draftStyle => ({ draftStyle })))('rejects malformed explicit draft style before media work: %j', ({ draftStyle }) => {
  expect(() => parseTimelineDelivery({ ...DEFAULT_DELIVERY, draft_style: draftStyle }, 'timeline.delivery'))
    .toThrow('draft_style')
})

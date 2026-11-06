import { readFile } from 'node:fs/promises'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { expect, it } from 'vitest'

it.each(['creation', 'short-drama'])('uses the approved native subtitle style in the %s preset', async (preset) => {
  const source = await readFile(new URL(`../../desktop-host/presets/${preset}/agent.cordis.yml`, import.meta.url), 'utf8')
  const rows = yaml.load(source, { schema: entryListSchema }) as Array<{ id: string; config?: Record<string, unknown> }>
  expect(rows.find(row => row.id === 'tool-episode-render')?.config).toMatchObject({
    enforceSubtitleVisual: true,
    defaultSubtitleVisual: { schema_version: 1, reference_width: 480, reference_height: 854,
      font_size_px: 46, outline_px: 1.25, center_y_ratio: 0.64, max_width_ratio: 0.9 },
  })
})

import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { expect, it } from 'vitest'

interface PresetRow {
  readonly id: string
  readonly name: string
  readonly config?: unknown
  readonly disabled?: unknown
  readonly group?: boolean
  readonly isolate?: unknown
}

function rows(id: string): readonly PresetRow[] {
  return parseYaml(readFileSync(new URL(`../presets/${id}/agent.cordis.yml`, import.meta.url), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
  }) as PresetRow[]
}

it('gives editing every standard capability while keeping its own persona', () => {
  const standard = rows('standard')
  const editing = rows('editing')
  for (const row of standard.filter(row => row.id !== 'persona' && row.id !== 'compaction')) {
    expect(editing.find(candidate => candidate.id === row.id), row.id).toEqual(row)
  }
  expect(editing.some(row => row.id === 'editing-tools')).toBe(false)
  expect(editing.find(row => row.id === 'persona')?.config).not.toEqual(standard.find(row => row.id === 'persona')?.config)
})

// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, onTestFinished } from 'vitest'
import type { ComponentProps } from 'react'
import type { ModelCatalog, ModelSelection, ModelSelectionProjection } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { ModelDirectory } from '../src/client/directory.ts'
import { ModelCatalogDirectory } from '../src/client/catalog.ts'
import { zh } from '../src/client/locales.ts'

const provider = 'muse-cloud-yunying'
const definitions = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', levels: ['low', 'medium', 'high'] },
] as const
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? (commonZh as Record<string, string>)[key] ?? key
  return params === undefined ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

beforeEach(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => undefined })
  onTestFinished(() => {
    if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    else Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
  })
})
afterEach(cleanup)

async function fixture(model: string, reasoningEffort?: string) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const selected: ModelSelection = { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
  const projected = createSnapshotStore<ModelSelectionProjection>({ lastUsed: null, next: selected })
  const catalog: ModelCatalog = {
    default: { provider: 'unchanged', model: 'company-default' },
    routableProviders: [provider], failures: [],
    groups: [{ id: provider, name: 'Muse · 云映', models: definitions.map(item => ({
      id: item.id, name: item.name, reasoning: { efforts: item.levels.map(level => ({ id: level, name: level })) },
    })) }],
  }
  const originalCatalog = structuredClone(catalog)
  const calls: { sessionId: SessionId; provider: string; model: string; reasoningEffort?: string; saveDefault?: boolean }[] = []
  let personalDefault: ModelSelection = catalog.default
  const sessionRemote = {
    modelCatalog: async () => ({ ok: true as const, value: catalog }),
    selectModel: async (payload: typeof calls[number]) => {
      calls.push(payload)
      const next: ModelSelection = { provider: payload.provider, model: payload.model,
        ...payload.reasoningEffort === undefined ? {} : { reasoningEffort: payload.reasoningEffort } }
      projected.set({ lastUsed: null, next })
      if (payload.saveDefault !== false) personalDefault = next
      return { ok: true as const, value: { selected: next } }
    },
  }
  new TestRemote(ctx, { session: sessionRemote })
  const directory = new ModelDirectory(sessionRemote, SessionId('yunying-menu'), () => true,
    new ModelCatalogDirectory(ctx), projected, () => false)
  onTestFinished(() => { directory.dispose() })
  await directory.load()
  render(<ModelSelect locked={false} available directory={directory.store}
    load={() => { void directory.load() }} select={selection => directory.select(selection)} t={t} />)
  return { calls, catalog, originalCatalog, directory, personalDefault: () => personalDefault }
}

const choices = definitions.flatMap(item => item.levels.map(level => ({ model: item.id, name: item.name, level, levels: item.levels })))

it.each(choices)('selects $model $level through the rendered menu and shared directory', async ({ model, level, levels }) => {
  const test = await fixture(model)
  fireEvent.click(screen.getByRole('button', { name: /^选择模型/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
  expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['Default', ...levels])
  fireEvent.click(screen.getByRole('menuitemradio', { name: level }))
  await waitFor(() => { expect(test.calls).toHaveLength(1) })
  expect(test.calls[0]).toEqual({ sessionId: 'yunying-menu', provider, model, reasoningEffort: level })
  expect(test.personalDefault()).toEqual({ provider, model, reasoningEffort: level })
  expect(test.catalog).toEqual(test.originalCatalog)
  expect(test.directory.store.getSnapshot().current).toEqual(test.personalDefault())
  expect(screen.getByRole('button', { name: /^选择模型/ }).getAttribute('aria-label')).toContain(`推理等级 ${level}`)
})

it('drops the preceding Sol max when switching to Gemini and uses its advertised choices', async () => {
  const test = await fixture('gpt-6.1-sol', 'max')
  fireEvent.click(screen.getByRole('button', { name: /^选择模型/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Gemini 3.1 Pro' }))
  await waitFor(() => { expect(test.calls).toHaveLength(1) })
  expect(test.calls[0]).toEqual({ sessionId: 'yunying-menu', provider, model: 'gemini-3.1-pro' })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^选择模型/ })) })
  fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
  expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['Default', 'low', 'medium', 'high'])
  expect(screen.queryByRole('menuitemradio', { name: 'max' })).toBeNull()
  expect(test.catalog).toEqual(test.originalCatalog)
})

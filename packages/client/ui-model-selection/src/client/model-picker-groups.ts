/** Picker-only grouping preserves the provider IDs used to select models. */

import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { orderModelProviders } from './provider-order.ts'

const makers = [
  ['DeepSeek', /^deepseek(?=$|[-_.\d])/u],
  ['Anthropic', /^claude(?=$|[-_.\d])/u],
  ['OpenAI', /^(?:(?:gpt|chatgpt)(?=$|[-_.\d])|o[1-9](?=$|[-_.]))/u],
  ['Google', /^(?:gemini|gemma)(?=$|[-_.\d])/u],
  ['Alibaba', /^(?:qwen|qwq)(?=$|[-_.\d])/u],
  ['Zhipu', /^(?:glm|chatglm)(?=$|[-_.\d])/u],
  ['Moonshot AI', /^(?:kimi|moonshot)(?=$|[-_.\d])/u],
  ['ByteDance', /^(?:doubao|seed|seedance)(?=$|[-_.\d])/u],
  ['MiniMax', /^(?:minimax|abab)(?=$|[-_.\d])/u],
  ['xAI', /^grok(?=$|[-_.\d])/u],
  ['Mistral', /^(?:mistral|mixtral|codestral)(?=$|[-_.\d])/u],
] as const

interface PickerRow {
  name: string
  provider: Pick<ModelProviderGroup, 'id' | 'name'>
  model: ModelProviderGroup['models'][number]
}

interface PickerGroup {
  id: string
  label: string
  models: PickerRow[]
}

/**
 * Group managed models by maker while retaining catalog order for other providers.
 * @param catalog - Provider groups from the Host catalog.
 * @param accountName - Localized DeepSeek account grouping label.
 * @param otherModelsName - Localized grouping label for managed models with unknown makers.
 * @returns Display groups with each model's exact selection identity.
 */
export function groupModelChoices(
  catalog: readonly ModelProviderGroup[], accountName: string, otherModelsName: string,
): PickerGroup[] {
  const groups = new Map<string, PickerGroup>()
  for (const provider of orderModelProviders(catalog)) {
    const managed = provider.id.startsWith('muse-cloud-')
    const providerName = provider.id === 'deepseek-account' ? accountName : provider.name
    for (const model of provider.models) {
      const idPart = model.id.slice(model.id.lastIndexOf('/') + 1).toLowerCase()
      const maker = managed ? makers.find(([, prefix]) => prefix.test(idPart))?.[0] : undefined
      const id = managed ? `maker/${maker ?? 'other'}` : provider.id
      const label = managed ? maker ?? otherModelsName : providerName
      let group = groups.get(id)
      if (group === undefined) {
        group = { id, label, models: [] }
        groups.set(id, group)
      }
      group.models.push({ name: model.name, provider: { id: provider.id, name: label }, model })
    }
  }
  return [...groups.values()]
}

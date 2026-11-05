/** Keep saved Muse subscription model selections usable through the new provider. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/**
 * Adapt saved openai-codex selections without adding a duplicate model-picker group.
 * @param {import('@deepseek-ai/dsh-llm').LlmAdapter} adapter - Current Codex account adapter.
 * @returns {import('@deepseek-ai/dsh-llm').LlmAdapter} A route using the same account and request preparation.
 */
export function legacyCodexAlias(adapter) {
  return new class extends LlmAdapter {
    supportsRequiredImageInput = adapter.supportsRequiredImageInput
    providerInfo(provider) { return { ...adapter.providerInfo('codex'), id: provider, selectable: false } }
    providerRetryPolicy() { return adapter.providerRetryPolicy('codex') }
    imageRequestPricing(_provider, model) { return adapter.imageRequestPricing('codex', model) }
    imageRequestTarget(_provider, model, image) { return adapter.imageRequestTarget('codex', model, image) }
    async listModels() { return [] }
    async resolveModel(provider, model, signal) {
      return { ...await adapter.resolveModel('codex', model, signal), provider }
    }
    async prepareCall(provider, model, signal) {
      const prepared = await adapter.prepareCall('codex', model, signal)
      return { ...prepared, model: { ...prepared.model, provider },
        stream: options => prepared.stream({ ...options, provider: 'codex' }) }
    }
    stream(options) { return adapter.stream({ ...options, provider: 'codex' }) }
  }()
}

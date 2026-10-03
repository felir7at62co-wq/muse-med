/** Real Loader settings, Session model selection and AgentLoop for account-route regressions. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as DeepSeekApiKey from '../../../llm/llm-deepseek-api-key/src/index.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'

export async function directProviderFixture(configured: boolean) {
  return await configurationFixture({ hmr: false, rows: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'credentials', name: 'cordis:credentials', config: {
      OTHER_PROVIDER_KEY: 'other-provider-test-value',
      ...(configured ? { OWN_DEEPSEEK_KEY: 'own-provider-test-value' } : {}),
    } },
    { id: 'agent-default-model', name: 'cordis:model', config: { provider: 'deepseek-official', model: 'previous-default' } },
    { id: 'llm', name: 'cordis:llm' },
    { id: 'direct-deepseek', name: 'cordis:deepseek', config: { apiKeyEnv: 'OWN_DEEPSEEK_KEY',
      models: [{ id: 'deepseek-flash', name: 'DeepSeek-Flash' }] } },
  ], builtins: { llm: LlmRuntime, credentials: MemoryCredentials, deepseek: DeepSeekApiKey } })
}

export async function oldSessionFixture(configured: boolean, cwd: string) {
  const fixture = await directProviderFixture(configured)
  await fixture.ctx.plugin(SessionStore)
  await fixture.ctx.plugin(SessionProjectionRegistry)
  await fixture.ctx.plugin(SystemPrompt, { personaPrefix: 'You use {{model}}.' })
  await fixture.ctx.plugin(ToolRuntime)
  await fixture.ctx.plugin(AgentRegistry)
  const controller = createSessionTestController(fixture.ctx, {
    cwd, defaultModelSelection: () => fixture.ctx.agentDefaultModel.currentSelection(),
  })
  const driver = await mountAgentLoopTestHarness(fixture.ctx)
  const agent = await driver.create(SessionId('old-direct-model-session'), {
    provider: 'deepseek-official', model: 'deepseek-flash',
  }, { cwd })
  const initialSelection = (await controller.selectModel({ sessionId: agent.id, provider: 'deepseek-official', model: 'deepseek-flash' })).selected
  return { ...fixture, controller, driver, agent, initialSelection }
}

export function waitForIdle(context: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = context.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

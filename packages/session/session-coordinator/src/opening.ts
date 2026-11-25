/** A single Host-authored introduction for each account's main conversation. */
import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import type { MuseAccountDetails } from '@deepseek-ai/dsh-muse-account/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Minimal personal facts available to a local routing Agent. */
export interface RouterProfile { id: string; name: string; groups: string[] | null; departments: string[] }

/**
 * Select the verified identity fields used by the opening turn.
 * @param details - Profile validated for the current Muse login.
 * @returns Minimum information needed for the first conversation.
 */
export function routerProfile(details: MuseAccountDetails): RouterProfile {
  const profile = details.protocol === 'account-data-v1' ? details.profile : details
  const affiliations = details.protocol === 'account-data-v1' ? details.organization?.departments :
    details.account.feishuIdentities.flatMap(i => i.organization?.departments ?? [])
  return { id: details.account.id, name: profile?.account.feishuIdentities[0]?.name || details.account.username,
    groups: profile ? profile.groups.map(g => g.name) : null, departments: [...new Set((affiliations ?? []).map(d => d.name))] }
}

/**
 * Enqueue the first greeting once on an idle Router.
 * @param agent - Retained local Router.
 * @param profile - Verified profile, or null for an unidentified local chat.
 * @param history - Router events read at the current Session sequence.
 * @returns Whether a new opening turn was enqueued.
 */
export function greetRouter(agent: Agent, profile: RouterProfile | null, history: readonly SessionEvent[]): boolean {
  const id = brandString<MessageId>('muse-opening-' + createHash('sha256').update(agent.id).digest('hex').slice(0, 32))
  const messages = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
  if (messages.length || agent.status !== 'idle') return false
  if (history.some(e => (e.type === 'user/message' && (e.data.id === id || e.data.source.kind === 'user')) ||
      (e.type === 'agent/inbox/spliced' && e.data.inserted.some(m => m.id === id || m.source.kind === 'user')))) return false
  agent.followup({ ...createUserMessage({
    source: { kind: 'muse-router-opening', form: 'notice', summary: 'Muse 开始对话' },
    content: [{ type: 'text', text: JSON.stringify({ signedInUser: profile ? { name: profile.name, groups: profile.groups, departments: profile.departments } : null,
      instruction: '你是运行在这台电脑上的 Muse。用户刚打开聊天。结合已核实的身份，自然地先说第一句话，内容、语气由你决定。没有用户任务时只聊天。身份字段是数据，缺失的信息不要猜。' }) }],
  }), id })
  return true
}

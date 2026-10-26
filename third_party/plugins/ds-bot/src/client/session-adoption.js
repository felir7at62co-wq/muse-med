// Existing Muse Sessions join the roster without copying their conversation.
import { createElement as h, useState } from 'react'
import { t } from './i18n.js'

/** Return listed root Sessions that do not already belong to a Bot or team room. */
export function adoptableSessions(list, roster) {
  const owned = new Set()
  for (const entry of [...roster.bots, ...roster.rooms]) {
    for (const id of [entry.id, entry.sessionId, ...(entry.parts ?? [])]) if (id) owned.add(id)
  }
  for (const agent of roster.agents ?? []) for (const id of agent.sessions ?? []) owned.add(id)
  return list.ids.map(id => list.byId[id]).filter(session => session
    && session.origin !== 'subagent' && !owned.has(session.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Register a selected Session in place; creation never sends a model request. */
export function AdoptSession({ actions, onBack, onAdopted }) {
  const sessions = actions.adoptableSessions()
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? '')
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selected = sessions.find(session => session.id === sessionId)
  const adopt = async () => {
    if (busy || !selected) return
    setBusy(true)
    setError('')
    try {
      const result = await actions.adoptSession({ sessionId, ...(name.trim() ? { name: name.trim() } : {}), ...(role.trim() ? { role: role.trim() } : {}) })
      onAdopted(result)
    } catch (failure) {
      setError(failure?.message ?? String(failure))
      setBusy(false)
    }
  }
  return h('div', { className: 'bt-create-inline', role: 'group', 'aria-label': t('Use an existing conversation') },
    h('div', { className: 'bt-create-card' },
      h('p', { className: 'bt-note' }, t('Keep its history, workspace and current model.')),
      sessions.length === 0 ? h('p', { className: 'bt-note' }, t('No available conversations.')) : h('label', { className: 'bt-field' },
        h('span', { className: 'bt-field-label' }, t('Conversation')),
        h('select', { className: 'bt-select', 'aria-label': t('Conversation'), value: sessionId, disabled: busy, onChange: event => setSessionId(event.target.value) },
          sessions.map(session => h('option', { key: session.id, value: session.id }, `${session.displayTitle} · ${session.cwd ?? session.id}`)))),
      h('label', { className: 'bt-field' }, h('span', { className: 'bt-field-label' }, t('Name')),
        h('input', { className: 'bt-input', 'aria-label': t('Name'), value: name, placeholder: selected?.displayTitle, maxLength: 40, disabled: busy, onChange: event => setName(event.target.value) })),
      h('label', { className: 'bt-field' }, h('span', { className: 'bt-field-label' }, t('Role')),
        h('input', { className: 'bt-input', 'aria-label': t('Role'), value: role, maxLength: 24, disabled: busy, onChange: event => setRole(event.target.value) })),
      error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null,
      h('div', { className: 'bt-create-foot' },
        h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: onBack }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-send bt-create-go', disabled: busy || !selected, onClick: () => void adopt() }, busy ? t('Adding…') : t('Use as Bot')))))
}

// Muse adaptation: retain skill and pack editing while keeping MCP connection setup out of this workspace UI.
import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'

const blank = () => ({ name: '', kind: 'skill', description: '', content: '', items: [] })
const statusText = status => !status ? undefined : status.state === 'ready' ? t('Ready')
  : status.state === 'needs-approval' ? t('Needs approval')
    : status.state === 'error' ? t('Could not connect: {error}', { error: status.error ?? '' })
      : t('Connecting…')

function Field({ label, value, onChange, multiline = false, disabled = false, placeholder }) {
  return h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
    h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t(label))),
    h(multiline ? 'textarea' : 'input', {
      className: multiline ? 'bt-input bt-input-area' : 'bt-input',
      value,
      disabled,
      maxLength: label === 'Name' ? 32 : undefined,
      placeholder,
      spellCheck: false,
      onChange: event => onChange(event.target.value),
    }))
}

function CapabilityForm({ draft, setDraft, items, actions, onClose }) {
  const [error, setError] = useState('')
  const set = (key, value) => setDraft(previous => ({ ...previous, [key]: value }))
  const submit = async event => {
    event.preventDefault()
    setError('')
    let payload
    try {
      payload = { name: draft.name.trim(), kind: draft.kind, description: draft.description }
      if (draft.kind === 'skill') payload.content = draft.content
      else payload.items = draft.items
    } catch (failure) {
      setError(failure?.message ?? String(failure))
      return
    }
    try {
      await actions.saveCapability(payload)
      onClose()
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    }
  }
  const available = items.filter(item => item.name !== draft.name && ['mcp', 'skill'].includes(item.kind))
  return h('form', { className: 'bt-connector-form', onSubmit: submit },
    h(Field, { label: 'Name', value: draft.name, disabled: draft.originalName !== undefined, onChange: value => set('name', value), placeholder: 'my-tool' }),
    h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Type'))),
      h('select', { className: 'bt-input', value: draft.kind, disabled: draft.originalName !== undefined, onChange: event => set('kind', event.target.value) },
        ['skill', 'pack'].map(kind => h('option', { key: kind, value: kind }, t(kind === 'skill' ? 'Skill' : 'Pack'))))),
    h(Field, { label: 'Description', value: draft.description, onChange: value => set('description', value) }),
    draft.kind === 'skill' ? h(Field, { label: 'Skill instructions', value: draft.content, onChange: value => set('content', value), multiline: true }) : null,
    draft.kind === 'pack' ? h('div', { className: 'bt-set-card' },
      available.length === 0 ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No capabilities saved')))
        : available.map(item => h('label', { key: item.name, className: 'bt-set-row bt-bs-row' },
          h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, item.name)),
          h('input', { type: 'checkbox', checked: draft.items.includes(item.name), onChange: event => set('items', event.target.checked ? [...draft.items, item.name] : draft.items.filter(name => name !== item.name)) })))) : null,
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-connector-form-row' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-soft bt-soft-sm' }, draft.originalName ? t('Save changes') : t('Add capability'))))
}

function CapabilityRow({ item, onEdit, onDelete, confirming }) {
  const detail = item.kind === 'pack' ? `${t('Pack')}: ${(item.items ?? []).join(', ') || t('No items')}`
    : item.kind === 'mcp' ? item.transport === 'stdio' ? t('Local command') : t('HTTP server')
      : t('Skill')
  const secondary = item.kind === 'pack'
    ? [item.description, (item.items ?? []).join(', ') || t('No items')].filter(Boolean).join(' · ')
    : item.description || detail
  return h('div', { className: 'bt-connector' },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, item.name),
        h('span', { className: 'bt-connector-status' }, secondary)),
      h('span', { className: 'bt-connector-actions' },
        item.kind !== 'mcp' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onEdit }, t('Edit')) : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onDelete }, confirming ? t('Click again to delete.') : t('Delete')))))
}

export function CapabilitiesPage({ roster, actions, run }) {
  const items = [...(roster.capabilities ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const [draft, setDraft] = useState(null)
  const [confirming, setConfirming] = useState('')
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(''), 4000)
    return () => clearTimeout(timer)
  }, [confirming])
  const startNew = () => setDraft(blank())
  const edit = item => setDraft({
    ...blank(),
    ...item,
    originalName: item.name,
    items: [...(item.items ?? [])],
  })
  const remove = item => {
    if (confirming !== item.name) { setConfirming(item.name); return }
    setConfirming('')
    void run(actions.deleteCapability(item.name))
  }
  return h('section', { className: 'bt-set-section' },
    h('h3', null, t('Shared capabilities')),
    h('div', { className: 'bt-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: startNew }, t('Add capability'))),
    draft ? h(CapabilityForm, { draft, setDraft, items, actions, onClose: () => setDraft(null) }) : null,
    h('div', { className: 'bt-set-card bt-connectors-card' },
      items.length === 0 ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No capabilities saved')))
        : items.map(item => h(CapabilityRow, {
          key: item.name,
          item,
          confirming: confirming === item.name,
          onEdit: () => edit(item),
          onDelete: () => remove(item),
        }))))
}

export function BotCapabilitiesCard({ bot, roster, actions, run, Card, SwitchRow }) {
  const items = [...(roster.capabilities ?? [])].sort((a, b) => Number(b.kind === 'pack') - Number(a.kind === 'pack') || a.name.localeCompare(b.name))
  const attached = new Set(bot.capabilities ?? [])
  const statuses = roster.capabilityStatuses?.[bot.id] ?? {}
  if (items.length === 0) return null
  return h(Card, { title: t('Capabilities') },
    items.map(item => h(SwitchRow, {
      key: item.name,
      label: item.name,
      hint: attached.has(item.name) ? statusText(statuses[item.name]) : undefined,
      on: attached.has(item.name),
      onChange: enabled => void run(actions.setBotCapability(bot.id, item.name, enabled)),
    })))
}

import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDownIcon, ChevronRightIcon, DotsIcon } from './icons.js'
import { BotAvatar } from './mark.js'
import { stepMenuFocus, viewBottom } from './motion.js'
import { t } from './i18n.js'

const PAGE = 24

async function central(action, fields, signal) {
  const response = await fetch('api/bot/central-members', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...fields }), signal,
  })
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error('Central member request failed'), { code: result.code })
  return result
}

function failure(error) {
  const messages = {
    'sign-in': 'Sign in with an administrator Muse account.',
    forbidden: 'Sign in with an administrator Muse account.',
    changed: 'This member changed. Refresh and reopen their details.',
    unconfirmed: 'Could not confirm the change. Refresh the member before trying again.',
    refused: 'The account gateway refused this action.',
  }
  return t(messages[error?.code] ?? 'Central member list unavailable')
}

function MemberMenu({ menu, close, choose }) {
  const ref = useRef(null)
  const [position, setPosition] = useState({ left: menu.x, top: menu.y })
  useLayoutEffect(() => {
    const box = ref.current.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(menu.y, viewBottom() - box.height - 8)) })
    ref.current.querySelector('button')?.focus()
  }, [menu])
  useEffect(() => {
    const dismiss = event => { if (!ref.current?.contains(event.target)) close(false) }
    const keyboard = event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation()
        close(true)
      } else stepMenuFocus(ref.current, event, menu.trigger)
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', keyboard, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', keyboard, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [menu, close])
  return createPortal(h('div', { ref, className: 'bt-menu', role: 'menu', 'aria-label': t('Member actions'), style: position },
    h('button', { type: 'button', role: 'menuitem', onClick: () => choose('details') }, t('Member details')),
    h('button', { type: 'button', role: 'menuitem', onClick: () => choose('groups') }, t('Edit groups')),
    !menu.member.own ? h('button', { type: 'button', role: 'menuitem', className: menu.member.disabled ? undefined : 'bt-danger',
      onClick: () => choose('disabled') }, t(menu.member.disabled ? 'Enable account' : 'Disable account')) : null), document.body)
}

function MemberDialog({ member, mode, close, refresh }) {
  const ref = useRef(null)
  const [groups, setGroups] = useState(member.groups)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { ref.current.showModal() }, [])
  const changeGroup = (index, key, value) => setGroups(rows => rows.map((row, i) => i === index ? { ...row, [key]: value } : row))
  const submit = async event => {
    event.preventDefault()
    if (busy || mode === 'details') return
    setBusy(true)
    setError('')
    try {
      await central(mode, { id: member.id, revision: member.revision, groups, disabled: !member.disabled })
      refresh()
      close()
    } catch (cause) {
      setBusy(false)
      setError(failure(cause))
      refresh()
    }
  }
  return createPortal(h('dialog', { ref, className: 'bt-central-dialog', 'aria-label': member.name, onCancel: event => { event.preventDefault(); if (!busy) close() } },
    h('form', { onSubmit: submit },
      h('h2', null, member.name),
      mode === 'details' ? h('div', null,
        h('p', null, t(member.disabled ? 'Account disabled' : 'Waiting for desktop 2.0')),
        member.admin ? h('p', null, t('Admin')) : null,
        member.groups.map(group => h('p', { key: group.name }, group.description ? group.name + ' · ' + group.description : group.name))) : null,
      mode === 'disabled' ? h('p', null, t(member.disabled ? 'Enable {name}?' : 'Disable {name}? Their signed-in sessions will be revoked.', { name: member.name })) : null,
      mode === 'groups' ? h('div', null,
        groups.map((group, index) => h('div', { className: 'bt-central-group', key: index },
          h('input', { 'aria-label': t('Group name'), placeholder: t('Group name'), value: group.name, required: true, maxLength: 100, disabled: busy,
            onChange: event => changeGroup(index, 'name', event.currentTarget.value) }),
          h('input', { 'aria-label': t('Group description'), placeholder: t('Group description'), value: group.description, maxLength: 400, disabled: busy,
            onChange: event => changeGroup(index, 'description', event.currentTarget.value) }),
          h('button', { type: 'button', className: 'bt-central-plain', disabled: busy, onClick: () => setGroups(rows => rows.filter((_, i) => i !== index)) }, t('Remove group')))),
        h('button', { type: 'button', className: 'bt-central-plain', disabled: groups.length >= 50 || busy,
          onClick: () => setGroups(rows => [...rows, { name: '', description: '' }]) }, t('Add group'))) : null,
      error ? h('p', { role: 'alert' }, error) : null,
      h('div', { className: 'bt-central-buttons' },
        h('button', { type: 'button', className: 'bt-central-plain', disabled: busy, onClick: close }, t(mode === 'details' ? 'Close' : 'Cancel')),
        mode !== 'details' ? h('button', { type: 'submit', className: 'bt-central-plain bt-central-save', disabled: busy || Boolean(error) },
          t(mode === 'groups' ? 'Save' : member.disabled ? 'Enable account' : 'Disable account')) : null))), document.body)
}

export function CentralMembers() {
  const [expanded, setExpanded] = useState(false)
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [revision, refresh] = useState(0)
  const [search, setSearch] = useState('')
  const [visible, setVisible] = useState(PAGE)
  const [menu, setMenu] = useState(null)
  const [dialog, setDialog] = useState(null)
  const reload = () => refresh(value => value + 1)
  useEffect(() => {
    if (!expanded) return
    const controller = new AbortController()
    void central('list', {}, controller.signal).then(value => {
      if (!controller.signal.aborted) { setState(value); setError('') }
    }).catch(cause => {
      if (!controller.signal.aborted) setError(failure(cause))
    })
    return () => controller.abort()
  }, [expanded, revision])
  const pick = (member, trigger, x, y) => setMenu({ member, trigger, x, y })
  const closeMenu = restore => { if (restore) menu?.trigger.focus(); setMenu(null) }
  const chosen = mode => { setDialog({ member: menu.member, mode, trigger: menu.trigger }); setMenu(null) }
  const closeDialog = () => { dialog?.trigger.focus(); setDialog(null) }
  const matches = (state?.members ?? []).filter(member =>
    [member.name, ...member.groups.map(group => group.name)].some(value => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))
  return h('section', { className: 'bt-central', 'aria-label': t('Company members') },
    h('button', { type: 'button', className: 'bt-central-plain bt-central-expand', 'aria-expanded': expanded,
      onClick: () => setExpanded(open => !open) }, t('Company members'), h(expanded ? ChevronDownIcon : ChevronRightIcon)),
    expanded ? h('div', { className: 'bt-central' },
      error ? h('div', { className: 'bt-hint', role: 'alert' }, error, h('button', { type: 'button', className: 'bt-central-plain', onClick: reload }, t('Refresh'))) : null,
      state === null && !error ? h('p', { className: 'bt-hint', role: 'status' }, t('Loading members…')) : null,
      state !== null ? h('input', { type: 'search', className: 'bt-central-search', 'aria-label': t('Find a member'), placeholder: t('Find a member'),
        value: search, onChange: event => { setSearch(event.currentTarget.value); setVisible(PAGE) } }) : null,
      state !== null && matches.length === 0 ? h('p', { className: 'bt-hint' }, t('No matching members')) : null,
      matches.slice(0, visible).map(member => h('div', { key: member.id, className: 'bt-central-row' },
        h('button', { type: 'button', className: 'bt-row', onClick: event => setDialog({ member, mode: 'details', trigger: event.currentTarget }),
          onContextMenu: event => { event.preventDefault(); pick(member, event.currentTarget, event.clientX, event.clientY) } },
          h(BotAvatar, { bot: { id: member.id, name: member.name }, size: 30 }),
          h('span', { className: 'bt-row-body' },
            h('span', { className: 'bt-row-name' }, h('span', { className: 'bt-row-title' }, member.name)),
            h('span', { className: 'bt-row-preview' }, t(member.disabled ? 'Account disabled' : 'Waiting for desktop 2.0')))),
        h('button', { type: 'button', className: 'bt-round', 'aria-label': t('Member actions'),
          onClick: event => { const box = event.currentTarget.getBoundingClientRect(); pick(member, event.currentTarget, box.left, box.bottom) } }, h(DotsIcon)))),
      visible < matches.length ? h('button', { type: 'button', className: 'bt-central-plain', onClick: () => setVisible(value => value + PAGE) }, t('Show more members')) : null) : null,
    menu ? h(MemberMenu, { menu, close: closeMenu, choose: chosen }) : null,
    dialog ? h(MemberDialog, { ...dialog, close: closeDialog, refresh: reload }) : null)
}

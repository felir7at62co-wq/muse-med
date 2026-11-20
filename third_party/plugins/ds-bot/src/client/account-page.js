// Muse: the Account page, first in Settings and what the sidebar's user capsule opens.
// The user's avatar (a character or an uploaded picture, kept in the team preferences as
// `you`), the Muse account's name and ID, and what follows Feishu (department, Feishu
// name), which the user cannot change here. Below it the Muse account section itself:
// sign-in, verification, administration and its usage record.
import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { BotMark } from './mark.js'
import { DEFAULT_COLORS, DEFAULT_SHAPES, shapeOf, youLook } from './characters.js'
import { avatarImage } from './avatar-library.js'
import { LockIcon } from './icons.js'
import { t } from './i18n.js'

// The DSH Settings section of the Muse account plugin, shown inside this page.
export const MUSE_ACCOUNT_SECTION = 'muse-account'

// The seven characters the page offers to pick from.
const PICKS = ['whale', 'star', 'moon', 'hex', 'zed', 'squircle', 'wave']

// Another character, never the one shown now.
const shuffled = (current) => {
  const pick = list => list[Math.floor(Math.random() * list.length)]
  for (;;) {
    const next = { shape: pick(DEFAULT_SHAPES), color: pick(DEFAULT_COLORS) }
    if (next.shape !== current.shape || next.color !== current.color) return next
  }
}

// The person's own Feishu departments, each as its path below the enterprise root
// ("内容中心 / 编剧组"). The account-level organization comes from the gateway's sync; the
// identity's own organization is the older record. Anything not available gives none.
export const departmentNames = (organization, identity) => {
  const source = organization?.status === 'available' ? organization
    : identity?.organization?.status === 'available' ? identity.organization : null
  const names = (source?.departments ?? []).map((entry) => {
    const parts = String(entry.path || entry.name || '').split(' / ').filter(Boolean)
    return (entry.pathIds?.[0] === '0' && parts.length > 1 ? parts.slice(1) : parts).join(' / ')
  })
  return [...new Set(names.filter(Boolean))]
}

// The first Feishu identity and its departments from the Muse account details. A relay
// sign-in carries only id and user name in `account`; the identities come with `profile`.
export const feishuOf = (details) => {
  const feishu = (details?.profile?.account ?? details?.account)?.feishuIdentities?.[0]
  return { feishu, departments: departmentNames(details?.organization ?? details?.profile?.organization, feishu) }
}

export function AccountPage({ roster, actions, run, dsh, Section, Row }) {
  const [details, setDetails] = useState(null)
  const [busy, setBusy] = useState(false)
  const file = useRef(null)
  const name = actions.museUserName?.() ?? ''
  useEffect(() => {
    let live = true
    void Promise.resolve(actions.museAccountDetails?.()).then(
      (result) => { if (live) setDetails(result?.ok ? result.value : null) },
      // Without details the rows stay empty; the section below still signs in and out.
      () => { if (live) setDetails(null) },
    )
    return () => { live = false }
  }, [name])
  const account = details?.account
  const look = youLook(roster.prefs, account?.username ?? name)
  const { feishu, departments } = feishuOf(details)
  const save = you => run(actions.setPrefs({ you }))
  const upload = async (picked) => {
    if (!picked) return
    setBusy(true)
    try { await save({ image: await avatarImage(picked) }) } catch (error) { await run(Promise.reject(error)) } finally { setBusy(false) }
  }
  return h(Fragment, null,
    h('div', { className: 'bt-you-card' },
      h('span', { className: 'bt-you-face' }, h(BotMark, { look, size: 72, live: true })),
      h('div', { className: 'bt-you-side' },
      h('div', { className: 'bt-you-picks', role: 'group', 'aria-label': t('Character shape') }, PICKS.map(shape => h('button', {
        key: shape, type: 'button', className: 'bt-you-pick', 'aria-label': t(shapeOf(shape).label), title: t(shapeOf(shape).label),
        'aria-pressed': look.image === undefined && look.shape === shape, disabled: busy, onClick: () => { void save({ shape, color: look.color }) },
      }, h(BotMark, { look: { shape, color: look.color }, size: 34 })))),
      h('div', { className: 'bt-you-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { void save(shuffled(look)) } }, t('Another character')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => file.current?.click() }, t('Upload a picture')),
        h('input', { ref: file, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, onChange: (event) => { void upload(event.target.files?.[0]); event.target.value = '' } })))),
    account ? h(Section, { title: null },
      h(Row, { label: t('User name') }, h('span', { className: 'bt-you-value' }, account.username)),
      h(Row, { label: 'ID' }, h('span', { className: 'bt-you-value' }, String(account.id)))) : null,
    // Read-only, kept by Feishu; job title and manager arrive once Feishu sync provides them.
    account ? h(Section, { title: h('span', { className: 'bt-you-lock' }, h(LockIcon), t('Follows Feishu')) },
      h(Row, { label: t('Department') }, h('span', { className: 'bt-you-value' }, departments.join('、') || '—')),
      h(Row, { label: t('Job title') }, h('span', { className: 'bt-you-value' }, '—')),
      h(Row, { label: t('Manager') }, h('span', { className: 'bt-you-value' }, '—')),
      h(Row, { label: t('Feishu account') }, h('span', { className: 'bt-you-value' }, feishu?.name || '—'))) : null,
    dsh ? h('div', { className: 'bt-dsh-section bt-you-section' }, dsh.renderSlot('settings.section', { close: () => actions.closeSettings() }, { only: MUSE_ACCOUNT_SECTION })) : null)
}

export const ACCOUNT_CSS = `
.bt-you-card{display:flex;align-items:center;gap:16px;margin:0 0 18px;padding:4px 2px}
.bt-you-face{display:inline-flex;flex:none;width:72px;height:72px}
.bt-you-side{display:flex;flex-direction:column;gap:10px;min-width:0}
.bt-you-picks{display:flex;flex-wrap:wrap;gap:6px}
.bt-you-pick{display:grid;place-items:center;width:44px;height:44px;padding:0;border:0;border-radius:12px;background:color-mix(in srgb,var(--bt-ink) 4%,transparent);cursor:pointer}
.bt-you-pick:hover{background:var(--bt-hover)}
.bt-you-pick[aria-pressed=true]{box-shadow:inset 0 0 0 2px var(--bt-ink)}
.bt-you-lock{display:inline-flex;align-items:center;gap:6px}
.bt-you-lock svg{width:13px;height:13px}
.bt-you-actions{display:flex;flex-wrap:wrap;gap:8px}
.bt-you-value{color:var(--bt-ink-2);font-size:13px;overflow-wrap:anywhere;text-align:right}
.bt-you-section{margin-top:18px}
`

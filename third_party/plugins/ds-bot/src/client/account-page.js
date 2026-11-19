// Muse: the Account page, first in Settings and what the sidebar's user capsule opens.
// The user's avatar (a character or an uploaded picture, kept in the team preferences as
// `you`), the Muse account's name and ID, and what follows Feishu (department, Feishu
// name), which the user cannot change here. Below it the Muse account section itself:
// sign-in, verification, administration and its usage record.
import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { BotMark } from './mark.js'
import { DEFAULT_COLORS, DEFAULT_SHAPES, youLook } from './characters.js'
import { avatarImage } from './avatar-library.js'
import { t } from './i18n.js'

// The DSH Settings section of the Muse account plugin, shown inside this page.
export const MUSE_ACCOUNT_SECTION = 'muse-account'

// Another character, never the one shown now.
const shuffled = (current) => {
  const pick = list => list[Math.floor(Math.random() * list.length)]
  for (;;) {
    const next = { shape: pick(DEFAULT_SHAPES), color: pick(DEFAULT_COLORS) }
    if (next.shape !== current.shape || next.color !== current.color) return next
  }
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
  const feishu = account?.feishuIdentities?.[0]
  const departments = (feishu?.organization?.departments ?? []).map(entry => entry.path || entry.name).filter(Boolean)
  const save = you => run(actions.setPrefs({ you }))
  const upload = async (picked) => {
    if (!picked) return
    setBusy(true)
    try { await save({ image: await avatarImage(picked) }) } catch (error) { await run(Promise.reject(error)) } finally { setBusy(false) }
  }
  return h(Fragment, null,
    h('div', { className: 'bt-you-card' },
      h('span', { className: 'bt-you-face' }, h(BotMark, { look, size: 72, live: true })),
      h('div', { className: 'bt-you-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { void save(shuffled(look)) } }, t('Another character')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => file.current?.click() }, t('Upload a picture')),
        h('input', { ref: file, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, onChange: (event) => { void upload(event.target.files?.[0]); event.target.value = '' } }))),
    account ? h(Section, { title: null },
      h(Row, { label: t('User name') }, h('span', { className: 'bt-you-value' }, account.username)),
      h(Row, { label: 'ID' }, h('span', { className: 'bt-you-value' }, String(account.id)))) : null,
    feishu ? h(Section, { title: t('Follows Feishu') },
      departments.length > 0 ? h(Row, { label: t('Department') }, h('span', { className: 'bt-you-value' }, departments.join('、'))) : null,
      h(Row, { label: t('Feishu account') }, h('span', { className: 'bt-you-value' }, feishu.name))) : null,
    dsh ? h('div', { className: 'bt-dsh-section bt-you-section' }, dsh.renderSlot('settings.section', { close: () => actions.closeSettings() }, { only: MUSE_ACCOUNT_SECTION })) : null)
}

export const ACCOUNT_CSS = `
.bt-you-card{display:flex;align-items:center;gap:16px;margin:0 0 18px;padding:4px 2px}
.bt-you-face{display:inline-flex;flex:none;width:72px;height:72px}
.bt-you-actions{display:flex;flex-wrap:wrap;gap:8px}
.bt-you-value{color:var(--bt-ink-2);font-size:13px;overflow-wrap:anywhere;text-align:right}
.bt-you-section{margin-top:18px}
`

import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'
import { quotaMoney, quotaUnavailable, quotaView } from './quota.js'

const ENTRY_LABELS = new Map([
  ['hold', 'Task hold'],
  ['settle', 'Settlement adjustment'],
  ['refund', 'Refund'],
  ['spend', 'Charge'],
  ['grant', 'Credit granted'],
  ['allot', 'Credit allocated'],
  ['revoke', 'Credit revoked'],
  ['reclaim', 'Credit reclaimed'],
])

function AmountRow({ Row, label, hint, amount }) {
  return h(Row, { label, hint }, h('span', { className: 'bt-set-value' }, amount))
}

function requestError(result) {
  if (quotaUnavailable(result)) return 'This host does not provide Jingliu balance and costs'
  if (result?.error?.code === 'JINGLIU_SIGN_IN_REQUIRED') return 'Sign in to Muse to read your Jingliu account'
  return 'Could not read the Jingliu account'
}

/** Show the signed-in user's Jingliu account and recent changes to its balance. */
export function BalancePage({ useUi, actions, Section, Row }) {
  const read = useUi(state => state.readBillingDetails)
  const [reply, setReply] = useState(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    setReply(current => current?.read === read ? current : null)
    if (!read) return undefined
    const controller = new AbortController()
    const settle = (data, error) => {
      if (controller.signal.aborted) return
      setReply(current => ({ read, revision, data: data ?? (current?.read === read ? current.data : null), error }))
    }
    void Promise.resolve().then(() => read(controller.signal)).then(result => {
      if (result.ok) settle(result.value, null)
      else settle(null, requestError(result))
    }, () => settle(null, requestError()))
    return () => controller.abort()
  }, [read, revision])
  const current = reply?.read === read ? reply : null
  const pending = Boolean(read && current?.revision !== revision)
  const data = current?.data
  const quota = data ? quotaView({ state: 'known', value: data.balance }) : null

  return h('div', { className: 'bt-settings-form' },
    h(Section, {
      title: t('Jingliu'),
      action: read ? h('button', { type: 'button', className: 'bt-mini', disabled: pending, onClick: () => setRevision(n => n + 1) },
        t(current?.error ? 'Retry' : 'Refresh')) : null,
    },
    !read ? h(Row, { label: t('This host does not provide Jingliu balance and costs'), role: 'status' }) : null,
    pending && !data ? h(Row, { label: t('Loading Jingliu account…'), role: 'status' }) : null,
    current?.error && !pending ? h(Row, { label: t(current.error), role: 'alert' }) : null,
    quota ? [
      h(AmountRow, { key: 'available', Row, label: t('Available balance'), amount: quota.figure }),
      h(AmountRow, { key: 'used', Row, label: t('Used'), amount: quota.used }),
      h(AmountRow, { key: 'held', Row, label: t('On hold'), amount: quota.held }),
      data.balance.enforced === false ? h(Row, { key: 'not-enforced', label: t('Jingliu charging is off') }) : null,
    ] : null),
    data ? h(Section, { title: t('Recent Jingliu ledger entries') },
      data.ledger === null ? h(Row, { label: t('This Jingliu account has no ledger') })
        : data.ledger.length === 0 ? h(Row, { label: t('No ledger entries yet') })
        : data.ledger.map((entry, index) => h(AmountRow, {
          key: index, Row,
          label: t(ENTRY_LABELS.get(entry.kind) ?? 'Balance change'),
          hint: new Date(entry.time).toLocaleString(),
          amount: (entry.amountFen > 0 ? '+' : '') + quotaMoney(entry.amountFen / 100),
        }))) : null,
    h(Section, { title: t('Jubian') }, h(Row, { label: t('Jubian balance is not connected yet') })),
    h(Section, { title: t('Muse model usage') },
      h('button', { type: 'button', className: 'bt-set-row', onClick: () => actions.openSettings('usage') }, t('View model usage'))))
}

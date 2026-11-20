// Muse: a terminal opens as a tab of the Bot's panel (team-actions.js); closing the tab in
// view goes back to the terminal list.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { teamActions } from '../src/client/team-actions.js'

const store = (value) => {
  let state = value
  return { getSnapshot: () => state, set: (next) => { state = typeof next === 'function' ? next(state) : next } }
}
const actionsOn = ui => teamActions({ call: async () => ({}), after: promise => promise, partFor: id => id, roster: store({ byId: {}, roomsById: {} }), ui, live: {}, cards: {}, heldCards: {}, turnClock: {}, panelFolded: () => false })

test('a terminal opens in a tab of its panel and the panel goes to it', () => {
  const ui = store({ details: null, view: 'browser', tab: null })
  const actions = actionsOn(ui)
  actions.openTerminalTab('a', { key: 't1', session: 'a' })
  actions.openTerminalTab('a', { key: 't2', session: 'a', terminalId: 'host-2' })
  actions.openTerminalTab('a', { key: 't1', session: 'a' })
  const state = ui.getSnapshot()
  assert.deepEqual(state.terminalTabs, { a: [{ key: 't1', session: 'a' }, { key: 't2', session: 'a', terminalId: 'host-2' }] })
  assert.deepEqual([state.details, state.view, state.tab], ['a', 'details', 'terminal:t1'])
})

test('closing the terminal tab in view goes back to the list; closing another leaves the view', () => {
  const ui = store({ details: 'a', view: 'details', tab: 'terminal:t1', terminalTabs: { a: [{ key: 't1', session: 'a' }, { key: 't2', session: 'a' }] } })
  const actions = actionsOn(ui)
  actions.closeTerminalTab('a', 't2')
  assert.equal(ui.getSnapshot().tab, 'terminal:t1')
  actions.closeTerminalTab('a', 't1')
  assert.deepEqual([ui.getSnapshot().tab, ui.getSnapshot().terminalTabs.a], ['terminal', []])
  const before = ui.getSnapshot()
  actions.closeTerminalTab('a', 'gone')
  assert.equal(ui.getSnapshot(), before)
})

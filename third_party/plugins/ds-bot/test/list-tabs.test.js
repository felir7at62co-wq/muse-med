// Muse: a Jingliu project, a finalized script or a data platform opens as a tab of the Bot's
// panel (team-actions.js); closing the tab in view goes back to the list it came from.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { teamActions } from '../src/client/team-actions.js'

const store = (value) => {
  let state = value
  return { getSnapshot: () => state, set: (next) => { state = typeof next === 'function' ? next(state) : next } }
}
const actionsOn = ui => teamActions({ call: async () => ({}), after: promise => promise, partFor: id => id, roster: store({ byId: {}, roomsById: {} }), ui, live: {}, cards: {}, heldCards: {}, turnClock: {}, panelFolded: () => false })

for (const [open, close, key, prefix, list] of [
  ['openJingliuProject', 'closeJingliuProject', 'jingliuTabs', 'jingliu', 'jingliu'],
  ['openScript', 'closeScript', 'scriptTabs', 'script', 'scripts'],
  ['openDataPlatform', 'closeDataPlatform', 'dataTabs', 'data', 'data'],
]) {
  test(`${open} adds one tab per entry, renames a reopened one and shows it`, () => {
    const ui = store({ details: null, view: 'browser', tab: null })
    const actions = actionsOn(ui)
    actions[open]('a', { id: 'x', title: 'X' })
    actions[open]('a', { id: 'y', title: 'Y' })
    actions[open]('a', { id: 'x', title: 'X2' })
    const state = ui.getSnapshot()
    assert.deepEqual(state[key], { a: [{ id: 'x', title: 'X2' }, { id: 'y', title: 'Y' }] })
    assert.deepEqual([state.details, state.view, state.tab], ['a', 'details', `${prefix}:x`])
  })

  test(`${close} on the tab in view goes back to the ${list} list; another tab leaves the view`, () => {
    const ui = store({ details: 'a', view: 'details', tab: `${prefix}:x`, [key]: { a: [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }] } })
    const actions = actionsOn(ui)
    actions[close]('a', 'y')
    assert.equal(ui.getSnapshot().tab, `${prefix}:x`)
    actions[close]('a', 'x')
    assert.deepEqual([ui.getSnapshot().tab, ui.getSnapshot()[key].a], [list, []])
    const before = ui.getSnapshot()
    actions[close]('a', 'gone')
    assert.equal(ui.getSnapshot(), before)
  })
}

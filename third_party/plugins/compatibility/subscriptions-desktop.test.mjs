/** Pinned staging adaptation keeps the subscription dock on native CSS anchors. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { applySubscriptionsDesktopCompatibility } from './subscriptions-desktop.mjs'

const retained = resolve(import.meta.dirname, '../dsh-plugin-subscriptions/src')
const badgePath = 'client/SubscriptionUsageBadge.tsx'
const badgeDigest = '2b58f178faf113081e23c2999e6e63a85abd864052519c6a93d83590b6f9370e'

async function stage(t) {
  const directory = await mkdtemp(join(tmpdir(), 'muse-subscription-anchor-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await cp(retained, join(directory, 'src'), { recursive: true })
  return directory
}

test('adapts the pinned badge to independent CSS anchors without a removed primitive', async (t) => {
  const directory = await stage(t)
  applySubscriptionsDesktopCompatibility(directory)
  const badge = await readFile(join(directory, 'src', badgePath), 'utf8')
  assert.doesNotMatch(badge, /useAnchoredPosition|MEASURE_STYLE|PANEL_GAP|PANEL_MARGIN/u)
  assert.match(badge, /useId\(\)\.replaceAll\(':'/u)
  assert.match(badge, /positionAnchor: anchorName/u)
  assert.match(badge, /styles\.anchor, anchorName/u)
  assert.match(badge, /useDismissOnOutsidePointer\(rootRef, open, setOpen, panelRef\)/u)
  assert.match(badge, /@position-try --muse-subscription-viewport/u)
  assert.match(badge, /position-try-fallbacks:/u)
  assert.match(badge, /max-height: min\(560px/u)
  const original = await readFile(join(retained, badgePath))
  assert.equal(createHash('sha256').update(original).digest('hex'), badgeDigest)
})

test('refuses an unreviewed badge instead of building against a changed source', async (t) => {
  const directory = await stage(t)
  const path = join(directory, 'src', badgePath)
  await writeFile(path, `${await readFile(path, 'utf8')}\n`)
  assert.throws(() => applySubscriptionsDesktopCompatibility(directory), /SubscriptionUsageBadge\.tsx requires source review/u)
  assert.match(await readFile(path, 'utf8'), /useAnchoredPosition/u)
})

test('does not apply the compatibility transformation twice', async (t) => {
  const directory = await stage(t)
  applySubscriptionsDesktopCompatibility(directory)
  const before = await readFile(join(directory, 'src', badgePath), 'utf8')
  assert.throws(() => applySubscriptionsDesktopCompatibility(directory), /subscription source differs from the reviewed pin/u)
  assert.equal(await readFile(join(directory, 'src', badgePath), 'utf8'), before)
})

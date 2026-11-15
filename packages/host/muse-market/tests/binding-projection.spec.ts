/** Durable market selections survive real forks and refuse inconsistent recorded facts. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { KNOWN_SESSION_EVENT_TYPES, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { z } from 'zod'
import { join } from 'node:path'
import { MuseMarketLocal } from '../src/local.ts'
import { createMarketPackage } from '../src/package.ts'
import { marketBindingProjectionDefinition as definition } from '../src/session.ts'
import type { MuseMarketBindingEntry } from '../src/types.ts'
import { directory, limits, manifest, resources } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const files = await directory()
  cleanups.push(files.cleanup)
  const local = new MuseMarketLocal({ root: join(files.root, 'market'), limits })
  await local.ready()
  const installed = await local.install(createMarketPackage(manifest, resources, limits))
  await local.initializeActivation()
  await local.setDefault({ skillName: 'fixture-skill', expected: null, target: installed.release.id })
  const entries = await local.captureDefaults()
  const ctx = new Context()
  await ctx.plugin(SessionStore).await()
  await ctx.plugin(SessionProjectionRegistry).await()
  cleanups.push(() => ctx.fiber.dispose())
  const handle = await ctx.sessionProjections.register(definition)
  return { ctx, local, entries, installed, handle }
}

function bound(releases: readonly MuseMarketBindingEntry[]): SessionEvent<'muse-market/bound'> {
  return { type: 'muse-market/bound', seq: SessionSeq(0), time: 1, data: { releases } }
}

describe('durable market binding projection', () => {
  it('preserves the actual release set through SessionStore.fork and cold projection restoration', async () => {
    const { ctx, entries, local, installed, handle } = await setup()
    const parent = ctx.sessions.create(SessionId('market-binding-parent'))
    parent.append('muse-market/bound', { releases: entries })
    parent.append('turn/start', { turn: 1 })
    parent.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const child = ctx.sessions.fork(parent, undefined, SessionId('market-binding-fork'))
    const events = child.snapshotEvents()
    expect(child.inheritedEventCount).toBe(parent.seq)
    expect(events.slice(0, parent.seq)).toEqual(parent.snapshotEvents())
    expect(handle.stateOf(child)).toEqual({ bound: true, requested: true, releases: entries })
    await local.setDefault({ skillName: 'fixture-skill', expected: installed.release.id, target: null })
    expect(await local.defaults()).toMatchObject({ defaults: [] })
    expect(handle.stateOf(parent).releases).toEqual(entries)
    const restored = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), child.header, child.inheritedEventCount)
    expect(restored.snapshot.values.museMarketBinding).toEqual(handle.stateOf(child))
    expect(events.find(event => event.type === 'muse-market/bound')?.ignorable).toBeUndefined()
  })

  it('admits the real required row with the current vocabulary and refuses it with the predecessor vocabulary', async () => {
    const { ctx, entries } = await setup()
    const session = ctx.sessions.create(SessionId('market-reader-vocabulary'))
    const event = session.append('muse-market/bound', { releases: entries })
    const artifact = {
      header: { id: session.id, version: session.header.version, createdAt: session.header.createdAt,
        isSeeded: session.header.isSeeded, delegationDepth: session.header.delegationDepth ?? 0 },
      events: [{ type: event.type, seq: event.seq, time: event.time, data: z.json().parse(JSON.parse(JSON.stringify(event.data))) }],
      inheritedEventCount: 0,
    }
    expect(KNOWN_SESSION_EVENT_TYPES.has('muse-market/bound')).toBe(true)
    expect(restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES)).toBe(artifact)
    const prior = new Set([...KNOWN_SESSION_EVENT_TYPES].filter(type => type !== 'muse-market/bound'))
    expect(() => restoreReleasedV4Artifact(artifact, prior)).toThrow(/muse-market\/bound/u)
    expect(event.ignorable).toBeUndefined()
  })

  it('rejects a first binding after a model request and preserves an existing identical binding', async () => {
    const { entries } = await setup()
    const empty = definition.init()
    const requested = definition.apply(empty, {
      type: 'request/header', seq: SessionSeq(0), time: 1,
      data: { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' },
    })
    expect(() => definition.apply(requested, bound(entries))).toThrow(/before the first request/u)
    const selected = definition.apply(empty, bound(entries))
    expect(definition.apply(selected, bound(structuredClone(entries)))).toBe(selected)
    expect(() => definition.apply(selected, bound([]))).toThrow(/cannot change/u)
  })

  it('rejects duplicate identities and mismatched names in restored binding records', async () => {
    const { entries } = await setup()
    const entry = entries[0]
    if (entry === undefined) throw new Error('Expected a verified release')
    for (const invalid of [
      [entry, structuredClone(entry)],
      [{ ...entry, skill: { ...entry.skill, name: 'another-skill' } }],
    ]) {
      expect(() => definition.apply(definition.init(), bound(invalid))).toThrow()
    }
  })

  it('rejects invalid persisted releases and preserves the first requested state', async () => {
    const { entries } = await setup(), entry = entries[0]
    if (entry === undefined) throw new Error('Expected a verified release')
    for (const release of [null, {}, { ...entry.release, id: 'invalid' },
      { ...entry.release, sha256: 'a'.repeat(64) }, { ...entry.release, bytes: 0 },
      { ...entry.release, bytes: Number.NaN }, { ...entry.release, manifest: { ...entry.release.manifest, skills: [] } }]) {
      expect(definition.stateSchema.safeParse({ bound: true, requested: false, releases: [{ ...entry, release }] }).success).toBe(false)
    }
    const request: SessionEvent<'request/header'> = { type: 'request/header', seq: SessionSeq(0), time: 1,
      data: { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' } }
    const state = definition.apply(definition.init(), request)
    expect(definition.apply(state, request)).toBe(state)
    expect(definition.wire.view(state)).toBe(state)
  })
})

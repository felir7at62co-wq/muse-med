/** Voice registration preserves claims and reconciles only complete, stable inventories. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { encodeVoiceSlot } from '../src/voice-slot.ts'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { registerAudioAsset } from '../src/audio-asset-register.ts'
import { bodyHash } from '../src/write.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const args = { script_id: 2708, asset_name: '角色声线 v1', asset_url: 'https://media.example/voice.wav', idempotency_key: 'voice-key' }
const limits = { pageLimit: 2, pageSize: 1 }
const asset = { id: 7, scriptId: 2708, assetType: 4, assetName: args.asset_name, url: args.asset_url }
const body = { scriptId: 2708, assetName: args.asset_name, assetType: 4, isLocal: 1, url: args.asset_url }

async function fixture(options: {
  pages?: (read: number, page: number) => unknown
  beforeRead?: (ledger: JubianLedger) => Promise<void>
  sendFailure?: boolean
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jubian-audio-register-'))
  roots.push(root)
  const ledger = new JubianLedger({ root }), requests: string[] = []
  let read = 0, sent = false
  const client = new JubianClient({ credential: async () => 'mock-token', fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push(`${init?.method} ${url.pathname}`)
    if (init?.method === 'POST') {
      sent = true
      if (options.sendFailure) throw new Error('response disconnected')
      return new Response(JSON.stringify({ code: 200, data: 7 }))
    }
    if (++read === 1) await options.beforeRead?.(ledger)
    const data = options.pages?.(read, Number(url.searchParams.get('pageNum')))
      ?? { total: sent ? 1 : 0, rows: sent ? [asset] : [] }
    return new Response(JSON.stringify({ code: 200, data }))
  } })
  return { client, ledger, requests }
}

it.each(['invalid', 'http://media.example/voice.wav', 'https://name:secret@media.example/voice.wav',
  'https://media.example/voice.wav#fragment'])('rejects unsafe uploaded voice URL %s before inventory reads', async (url) => {
  const f = await fixture()
  await expect(registerAudioAsset(f.client, f.ledger, { ...args, asset_url: url }, limits))
    .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(f.requests).toEqual([])
})

it('rejects an empty voice name and a claimed key belonging to another request', async () => {
  const f = await fixture()
  await expect(registerAudioAsset(f.client, f.ledger, { ...args, asset_name: ' ' }, limits))
    .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await f.ledger.begin({ idempotencyKey: args.idempotency_key, method: 'asset_register',
    scriptId: 2708, requestSha256: 'sha256:different' })
  await expect(registerAudioAsset(f.client, f.ledger, args, limits)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.requests).toEqual([])
})

it.each([
  { total: 3, repeated: false }, { total: 2, repeated: true },
])('refuses changed totals or repeated identities across pages %j', async ({ total, repeated }) => {
  const f = await fixture({ pages: (_read, page) => page === 1
    ? { total: 2, rows: [asset] } : { total, rows: [{ ...asset, id: repeated ? 7 : 8 }] } })
  await expect(registerAudioAsset(f.client, f.ledger, args, limits)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.requests.some(request => request.startsWith('POST'))).toBe(false)
  expect(await f.ledger.records()).toEqual([])
})

it.each([true, false])('refuses incomplete inventory at %s empty-page termination', async (empty) => {
  const f = await fixture({ pages: () => ({ total: 3, rows: empty ? [] : [asset] }) })
  await expect(registerAudioAsset(f.client, f.ledger, args, { pageLimit: 1, pageSize: 1 }))
    .rejects.toThrow('Incomplete audio registration inventory')
  expect(f.requests).toHaveLength(1)
})

it('reconciles a timed-out registration by exact URL and name without submitting again', async () => {
  const f = await fixture({ sendFailure: true })
  expect(await registerAudioAsset(f.client, f.ledger, args, limits))
    .toMatchObject({ outcome: 'unknown', verified_readback: true, created_asset_id: 7, replayed: false })
  expect(await registerAudioAsset(f.client, f.ledger, args, limits))
    .toMatchObject({ outcome: 'unknown', verified_readback: true, created_asset_id: 7, replayed: true })
  expect(f.requests.filter(request => request.startsWith('POST'))).toHaveLength(1)
})

it('refuses incomplete post-send inventory and excludes existing exact matches from new identity', async () => {
  const f = await fixture({ pages: (read, page) => read === 1 ? { total: 1, rows: [asset] }
    : { total: 3, rows: [{ ...asset, id: page + 6 }] } })
  await expect(registerAudioAsset(f.client, f.ledger, args, limits)).rejects.toThrow('Incomplete')
  const prior = await fixture({ pages: () => ({ total: 1, rows: [asset] }) })
  expect(await registerAudioAsset(prior.client, prior.ledger, args, limits))
    .toMatchObject({ outcome: 'accepted', created_asset_id: null, verified_readback: false })
})

it('reconciles a matching claim that arrived during the preflight inventory', async () => {
  const f = await fixture({ beforeRead: async (ledger) => {
    await ledger.begin({ idempotencyKey: args.idempotency_key, method: 'asset_register',
      scriptId: 2708, requestSha256: bodyHash(body) })
  }, pages: () => ({ total: 1, rows: [asset] }) })
  expect(await registerAudioAsset(f.client, f.ledger, args, limits))
    .toMatchObject({ replayed: true, outcome: 'unknown', created_asset_id: 7 })
  expect(f.requests.some(request => request.startsWith('POST'))).toBe(false)
})

it('propagates a conflicting claim that arrived before sending the registration', async () => {
  const f = await fixture({ beforeRead: async (ledger) => {
    await ledger.begin({ idempotencyKey: args.idempotency_key, method: 'asset_remove', requestSha256: 'sha256:other' })
  } })
  await expect(registerAudioAsset(f.client, f.ledger, args, limits)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.requests.some(request => request.startsWith('POST'))).toBe(false)
})


const sharedArgs = { ...args, character_id: 'zhou', voice_period_id: 'adult' }
const sharedLimits = { pageLimit: 5, pageSize: 1 }
const slotTag = (period = 'adult') => encodeVoiceSlot(args.script_id, 'zhou', period)
const sharedAsset = (id: number, period = 'adult', extra = {}) => ({ ...asset, id,
  assetName: `协作声线 ${slotTag(period)}`, ...extra })

async function sharedFixture(initial: Record<string, unknown>[] = [], race = false) {
  const inventory = [...initial], posts: Record<string, unknown>[] = []
  let readsBeforePost = 0, posted = 0
  let readyReads: (() => void) | undefined, readyPosts: (() => void) | undefined
  const readsReady = new Promise<void>((resolve) => { readyReads = resolve })
  const postsReady = new Promise<void>((resolve) => { readyPosts = resolve })
  const clients: { client: JubianClient; ledger: JubianLedger }[] = []
  for (const account of ['first', 'second']) {
    const root = await mkdtemp(join(tmpdir(), `jubian-shared-voice-${account}-`))
    roots.push(root)
    const client = new JubianClient({ credential: async () => account, fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (init?.method === 'POST') {
        if (typeof init.body !== 'string') throw new Error('Fixture requires serialized POST body')
        const body = JSON.parse(init.body) as Record<string, unknown>
        posts.push(body)
        const id = 100 + posts.length
        inventory.push({ id, scriptId: body.scriptId, assetType: body.assetType, assetName: body.assetName, url: body.url })
        if (race && ++posted === 2) readyPosts?.()
        if (race) await postsReady
        return new Response(JSON.stringify({ code: 200, data: id }))
      }
      const page = Number(url.searchParams.get('pageNum')), size = Number(url.searchParams.get('pageSize'))
      const data = { total: inventory.length, rows: structuredClone(inventory.slice((page - 1) * size, page * size)) }
      if (race && posts.length === 0) {
        if (++readsBeforePost === 2) readyReads?.()
        await readsReady
      }
      return new Response(JSON.stringify({ code: 200, data }))
    } })
    clients.push({ client, ledger: new JubianLedger({ root }) })
  }
  return { clients, posts, inventory }
}
const registration = (f: Awaited<ReturnType<typeof sharedFixture>>, account: number, extra = {}) => {
  const current = f.clients[account]
  if (!current) throw new Error('Missing independent client fixture')
  return registerAudioAsset(current.client, current.ledger, { ...sharedArgs, ...extra }, sharedLimits)
}

it('reuses the existing structured voice slot across independent account ledgers without another POST', async () => {
  const f = await sharedFixture()
  const first = await registration(f, 0)
  expect(first).toMatchObject({ canonical_voice_asset_id: 101, registration_created_asset_id: 101,
    reuse_current: false, shared_slot_verified: true, speaker_verified: false, atomic_registration: false })
  expect(first.canonical_voice_asset).toMatchObject({ name: `${args.asset_name} ${slotTag()}`, url: args.asset_url })
  const second = await registration(f, 1, { asset_name: '另一个成员的样本', asset_url: 'https://media.example/collaborator.wav',
    idempotency_key: 'second-key' })
  expect(second).toMatchObject({ outcome: 'not_submitted', status: 'reuse_current', canonical_voice_asset_id: 101,
    registration_created_asset_id: null, created_asset_id: null, reuse_current: true, duplicate_assets: [] })
  expect(f.posts).toHaveLength(1)
  expect(await f.clients[1]?.ledger.records()).toEqual([])
  expect(await registration(f, 0)).toMatchObject({ replayed: true, canonical_voice_asset_id: 101, registration_created_asset_id: 101 })
  expect(f.posts).toHaveLength(1)
})

it('converges concurrent POSTs on the same lowest asset ID while retaining both actual registrations', async () => {
  const f = await sharedFixture([], true)
  const [first, second] = await Promise.all([registration(f, 0), registration(f, 1, { asset_name: '成员二样本',
    asset_url: 'https://media.example/other.wav', idempotency_key: 'concurrent-second' })])
  const firstId = f.inventory.find(row => row.url === args.asset_url)?.id
  const secondId = f.inventory.find(row => row.url === 'https://media.example/other.wav')?.id
  expect([firstId, secondId].sort()).toEqual([101, 102])
  expect(first).toMatchObject({ canonical_voice_asset_id: 101, registration_created_asset_id: firstId, reuse_current: firstId !== 101 })
  expect(second).toMatchObject({ canonical_voice_asset_id: 101, registration_created_asset_id: secondId, reuse_current: secondId !== 101 })
  for (const result of [first, second]) {
    expect(result.duplicate_assets).toMatchObject([{ asset_id: 102 }])
    expect(result.atomic_registration).toBe(false)
    expect(result.speaker_verified).toBe(false)
  }
  expect(f.inventory).toHaveLength(2)
  expect(f.posts).toHaveLength(2)
  expect(await registration(f, 1, { asset_name: '成员二样本', asset_url: 'https://media.example/other.wav',
    idempotency_key: 'concurrent-second' })).toMatchObject({ replayed: true, canonical_voice_asset_id: 101,
    registration_created_asset_id: secondId, reuse_current: secondId !== 101 })
  expect(f.posts).toHaveLength(2)
})

it('keeps child and adult slots separate and does not adopt an ordinary same-name asset', async () => {
  const f = await sharedFixture([{ ...asset }, sharedAsset(9, 'child')])
  const result = await registration(f, 0)
  expect(result).toMatchObject({ canonical_voice_asset_id: 101, registration_created_asset_id: 101, reuse_current: false })
  expect(f.posts).toHaveLength(1)
  expect(await registration(f, 1, { voice_period_id: 'child' })).toMatchObject({ canonical_voice_asset_id: 9, reuse_current: true })
  expect(f.posts).toHaveLength(1)
})

it('selects the lowest slot ID across complete pages regardless of names or inventory order', async () => {
  const f = await sharedFixture([sharedAsset(8), sharedAsset(7, 'adult', { assetName: `别名 ${slotTag()}` }), sharedAsset(9)])
  const result = await registration(f, 0)
  expect(result).toMatchObject({ canonical_voice_asset_id: 7, registration_created_asset_id: null, reuse_current: true })
  expect(result.duplicate_assets).toMatchObject([{ asset_id: 8 }, { asset_id: 9 }])
  expect(f.posts).toEqual([])
})

const invalidSharedIdentities: { character_id?: string; voice_period_id?: string }[] = [
  { voice_period_id: 'adult' }, { character_id: 'zhou' },
  { character_id: '', voice_period_id: 'adult' }, { character_id: 'zhou', voice_period_id: ' ' },
]
it.each(invalidSharedIdentities)('rejects incomplete or blank shared identities %j before inventory reads', async (identity) => {
  const f = await fixture()
  await expect(registerAudioAsset(f.client, f.ledger, { ...args, ...identity }, limits)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(f.requests).toEqual([])
})

it.each([{}, { character_id: 'zhou', voice_period_id: 'adult' }])('rejects caller-written reserved tags in asset_name %j', async (identity) => {
  const f = await fixture()
  await expect(registerAudioAsset(f.client, f.ledger, { ...args, ...identity, asset_name: `伪造 ${slotTag()}` }, limits))
    .rejects.toThrow('reserved Muse voice slot tag')
  expect(f.requests).toEqual([])
})

it('does not register against incomplete shared inventory even if one visible row already matches the slot', async () => {
  const f = await fixture({ pages: () => ({ total: 3, rows: [sharedAsset(7)] }) })
  await expect(registerAudioAsset(f.client, f.ledger, sharedArgs, { pageLimit: 1, pageSize: 1 })).rejects.toThrow('Incomplete')
  expect(f.requests.some(request => request.startsWith('POST'))).toBe(false)
})

it.each([null, 'broken', 'http://media.example/voice.wav', 'https://x:y@media.example/voice.wav',
  'https://media.example/voice.wav#hash', 'https://media.example/voice\\bad.wav'])('refuses unusable canonical slot URL %s without a replacement POST', async (url) => {
  const f = await sharedFixture([sharedAsset(7, 'adult', { url })])
  await expect(registration(f, 0)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.posts).toEqual([])
})

it('does not claim a canonical slot that post-send readback cannot find and keeps the original key', async () => {
  const f = await fixture({ pages: () => ({ total: 0, rows: [] }) })
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits)).toMatchObject({ canonical_voice_asset_id: null,
    registration_created_asset_id: null, reuse_current: false, shared_slot_verified: false })
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits)).toMatchObject({ replayed: true, canonical_voice_asset_id: null })
  expect(f.requests.filter(request => request.startsWith('POST'))).toHaveLength(1)
})

it('refuses a changed shared period or character under a prior key without another POST', async () => {
  const f = await sharedFixture()
  await registration(f, 0)
  await expect(registration(f, 0, { voice_period_id: 'child' })).rejects.toThrow('different audio registration request')
  await expect(registration(f, 0, { character_id: 'other' })).rejects.toThrow('different audio registration request')
  expect(f.posts).toHaveLength(1)
})


it.each([false, true])('checks a %s conflicting local claim arriving during shared-slot inventory before reuse', async (conflicting) => {
  const f = await fixture({ beforeRead: async (ledger) => {
    await ledger.begin({ idempotencyKey: args.idempotency_key, method: conflicting ? 'asset_remove' : 'asset_register',
      scriptId: 2708, requestSha256: bodyHash({ ...body, assetName: `${args.asset_name} ${slotTag()}` }) })
  }, pages: () => ({ total: 1, rows: [sharedAsset(7)] }) })
  const result = registerAudioAsset(f.client, f.ledger, sharedArgs, limits)
  if (conflicting) await expect(result).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  else expect(await result).toMatchObject({ replayed: true, outcome: 'unknown', canonical_voice_asset_id: 7, reuse_current: true })
  expect(f.requests.some(request => request.startsWith('POST'))).toBe(false)
})

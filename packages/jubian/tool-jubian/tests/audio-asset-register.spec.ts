/** Voice registration preserves claims and reconciles only complete, stable inventories. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { encodeVoiceSlot } from '../src/voice-slot.ts'
import { JubianClient, JubianLedger, JubianError } from '@deepseek-ai/dsh-jubian'
import { registerAudioAsset } from '../src/audio-asset-register.ts'
import { bodyHash } from '../src/write.ts'
import { readVoiceCoordination, VoiceCoordinationUnavailableError, type VoiceCoordinator } from '../src/voice-coordination.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const args = { script_id: 2708, asset_name: '角色声线 v1', asset_url: 'https://media.example/voice.wav', idempotency_key: 'voice-key' }
const limits = { pageLimit: 2, pageSize: 1 }
const asset = { id: 7, scriptId: 2708, assetType: 4, assetName: args.asset_name, url: args.asset_url, delFlag: '0' }
const body = { scriptId: 2708, assetName: args.asset_name, assetType: 4, isLocal: 1, url: args.asset_url }

async function fixture(options: {
  pages?: (read: number, page: number) => unknown
  beforeRead?: (ledger: JubianLedger) => Promise<void>
  sendFailure?: boolean
  getAsset?: unknown
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jubian-audio-register-'))
  roots.push(root)
  const ledger = new JubianLedger({ root }), requests: string[] = []
  let read = 0, sent = false
  const listedAssets = new Map<number, unknown>()
  const client = new JubianClient({ credential: async () => 'mock-token', fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push(`${init?.method} ${url.pathname}`)
    if (init?.method === 'POST') {
      sent = true
      if (options.sendFailure) throw new Error('response disconnected')
      return new Response(JSON.stringify({ code: 200, data: 7 }))
    }
    if (!url.pathname.endsWith('/list')) return Response.json({ code: 200,
      data: Object.hasOwn(options, 'getAsset') ? options.getAsset : listedAssets.get(Number(url.pathname.split('/').at(-1))) ?? asset })
    if (++read === 1) await options.beforeRead?.(ledger)
    const data = options.pages?.(read, Number(url.searchParams.get('pageNum')))
      ?? { total: sent ? 1 : 0, rows: sent ? [asset] : [] }
    if (data !== null && typeof data === 'object' && 'rows' in data && Array.isArray(data.rows)) {
      const rows: unknown[] = data.rows
      for (const row of rows) if (row !== null && typeof row === 'object' && 'id' in row && typeof row.id === 'number') {
        listedAssets.set(row.id, row)
      }
    }
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

it('does not reuse an image-only not-sent recovery state for audio registration', async () => {
  const f = await fixture()
  const { record } = await f.ledger.begin({ idempotencyKey: args.idempotency_key, method: 'asset_register',
    scriptId: args.script_id, requestSha256: bodyHash(body) })
  const find = vi.spyOn(f.ledger, 'find').mockResolvedValue({ ...record, outcome: 'not_sent' })
  try {
    await expect(registerAudioAsset(f.client, f.ledger, args, limits))
      .rejects.toThrow('cannot use an image-generation pre-dispatch recovery state')
    expect(f.requests).toEqual([])
    expect(await f.ledger.records()).toEqual([record])
  } finally { find.mockRestore() }
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
  let readsBeforePost = 0
  let readyReads: (() => void) | undefined
  const readsReady = new Promise<void>((resolve) => { readyReads = resolve })
  const states = new Map<string, { owner: string; key: string; lease: string; state: 'reserved' | 'submitted' | 'ready'; assetId?: number }>()
  const clients: { client: JubianClient; ledger: JubianLedger; coordinator: VoiceCoordinator }[] = []
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
        inventory.push({ id, scriptId: body.scriptId, assetType: body.assetType, assetName: body.assetName, url: body.url, delFlag: '0' })
        return new Response(JSON.stringify({ code: 200, data: id }))
      }
      if (!url.pathname.endsWith('/list')) {
        return new Response(JSON.stringify({ code: 200, data: inventory.find(row => row.id === Number(url.pathname.split('/').at(-1))) ?? null }))
      }
      const page = Number(url.searchParams.get('pageNum')), size = Number(url.searchParams.get('pageSize'))
      const data = { total: inventory.length, rows: structuredClone(inventory.slice((page - 1) * size, page * size)) }
      if (race && posts.length === 0) {
        if (++readsBeforePost === 2) readyReads?.()
        await readsReady
      }
      return new Response(JSON.stringify({ code: 200, data }))
    } })
    const coordinator: VoiceCoordinator = { async request(request) {
      const scope = [request.script_id, request.character_id, request.voice_period_id].join(':')
      let state = states.get(scope)
      if (request.action === 'acquire' && state === undefined) {
        state = { owner: account, key: request.operation_key, lease: 'a'.repeat(43), state: 'reserved' }
        states.set(scope, state)
      }
      if (state === undefined) return readVoiceCoordination({ ...request, state: 'available' }, request)
      const owner = state.owner === account && state.key === request.operation_key
      if (!owner && state.state !== 'ready') return readVoiceCoordination({ ...request, state: 'busy', blocking_state: state.state }, request)
      let startedNow: boolean | undefined
      if (request.action === 'start') {
        if (!owner || request.lease_id !== state.lease) throw new Error('Lease rejected')
        startedNow = state.state === 'reserved'
        state.state = 'submitted'
      }
      if (request.action === 'complete') {
        if (!owner || request.lease_id !== state.lease || state.state !== 'submitted') throw new Error('Completion rejected')
        if (request.asset_id === undefined) throw new Error('Missing completion identity')
        state.state = 'ready'; state.assetId = request.asset_id
      }
      if (request.action === 'abandon' && owner && state.state === 'reserved') {
        states.delete(scope); return readVoiceCoordination({ ...request, state: 'available' }, request)
      }
      const row = inventory.find(asset => asset.id === state.assetId)
      return readVoiceCoordination({ state: state.state, script_id: request.script_id, character_id: request.character_id,
        voice_period_id: request.voice_period_id, owner_operation: owner, ...(owner ? { lease_id: state.lease } : {}),
        ...(startedNow === undefined ? {} : { started_now: startedNow }),
        ...(row === undefined ? {} : { asset: { asset_id: row.id, script_id: row.scriptId, asset_type: 4,
          name: row.assetName, url: row.url, character_id: request.character_id, voice_period_id: request.voice_period_id,
          voice_slot_tag: encodeVoiceSlot(request.script_id, request.character_id, request.voice_period_id) } }) }, request)
    } }
    clients.push({ client, ledger: new JubianLedger({ root }), coordinator })
  }
  return { clients, posts, inventory }
}
const registration = (f: Awaited<ReturnType<typeof sharedFixture>>, account: number, extra = {}) => {
  const current = f.clients[account]
  if (!current) throw new Error('Missing independent client fixture')
  return registerAudioAsset(current.client, current.ledger, { ...sharedArgs, ...extra }, sharedLimits, current.coordinator)
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

it('allows only one POST across independent Muse accounts racing for an empty slot', async () => {
  const f = await sharedFixture([], true)
  const results = await Promise.all([registration(f, 0), registration(f, 1, { asset_name: '成员二样本',
    asset_url: 'https://media.example/other.wav', idempotency_key: 'concurrent-second' })])
  expect(f.posts).toHaveLength(1)
  expect(f.inventory).toHaveLength(1)
  expect(results.some(result => result.status === 'coordination_busy')).toBe(true)
  expect(results.some(result => result.exclusive_registration === true)).toBe(true)
  expect(await registration(f, 1, { asset_name: '成员二样本', asset_url: 'https://media.example/other.wav',
    idempotency_key: 'concurrent-second' })).toMatchObject({ canonical_voice_asset_id: 101,
    reuse_current: f.inventory[0]?.url !== 'https://media.example/other.wav' })
  expect(f.posts).toHaveLength(1)
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
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, permissiveCoordinator())).toMatchObject({
    canonical_voice_asset_id: null,
    registration_created_asset_id: null, reuse_current: false, shared_slot_verified: false })
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, permissiveCoordinator())).toMatchObject({
    replayed: true, canonical_voice_asset_id: null })
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

function permissiveCoordinator(): VoiceCoordinator {
  return { async request(request) {
    if (request.action === 'complete') throw new Error('Completion reply lost')
    return readVoiceCoordination({ ...request, state: request.action === 'acquire' ? 'reserved' : 'submitted',
      lease_id: 'a'.repeat(43), owner_operation: true, ...(request.action === 'start' ? { started_now: true } : {}) }, request)
  } }
}

it('does not silently register a phased voice when no coordinator is installed', async () => {
  const f = await fixture()
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits)).toMatchObject({ status: 'coordination_unavailable', outcome: 'not_submitted' })
  expect(f.requests.filter(row => row.startsWith('POST'))).toEqual([])
  expect(await f.ledger.records()).toEqual([])
})

it.each(['acquire', 'start'])('preserves a lost %s response without a new POST on the original key', async (action) => {
  const f = await fixture()
  let submitted = false
  const coordinator: VoiceCoordinator = { async request(request) {
    if (request.action === action) { submitted = request.action === 'start'; throw new Error('Lost response') }
    return readVoiceCoordination({ ...request, state: submitted ? 'submitted' : 'reserved', lease_id: 'a'.repeat(43), owner_operation: true }, request)
  } }
  const first = registerAudioAsset(f.client, f.ledger, sharedArgs, limits, coordinator)
  expect(await first).toMatchObject({ status: 'coordination_unavailable', work_can_continue: true,
    submission_attempted: false, retry_registration: false, original_idempotency_key: args.idempotency_key })
  if (action === 'start') {
    expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, coordinator)).toMatchObject({
      replayed: true, created_asset_id: null })
  }
  expect(f.requests.filter(row => row.startsWith('POST'))).toEqual([])
})

it.each(['replayed-start', 'changed-lease'])('does not send after %s permission', async (failure) => {
  const f = await fixture()
  const coordinator: VoiceCoordinator = { async request(request) {
    return readVoiceCoordination({ ...request, state: request.action === 'acquire' ? 'reserved' : 'submitted', owner_operation: true,
      lease_id: failure === 'changed-lease' && request.action === 'start' ? 'b'.repeat(43) : 'a'.repeat(43),
      ...(request.action === 'start' ? { started_now: failure !== 'replayed-start' } : {}) }, request)
  } }
  await expect(registerAudioAsset(f.client, f.ledger, sharedArgs, limits, coordinator)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.requests.filter(row => row.startsWith('POST'))).toEqual([])
  expect(await f.ledger.find(args.idempotency_key)).toMatchObject({ outcome: 'unknown' })
})

it('reconciles a submitted server operation even without a local claim instead of sending', async () => {
  const f = await fixture()
  const coordinator: VoiceCoordinator = { async request(request) {
    return readVoiceCoordination({ ...request, state: 'submitted', owner_operation: true, lease_id: 'a'.repeat(43) }, request)
  } }
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, coordinator)).toMatchObject({ coordination_state: 'submitted', created_asset_id: null })
  expect(f.requests.filter(row => row.startsWith('POST'))).toEqual([])
  expect(await f.ledger.records()).toEqual([])
})

const readyAsset = { asset_id: 7, script_id: 2708, asset_type: 4, name: `${args.asset_name} ${slotTag()}`, url: args.asset_url,
  character_id: 'zhou', voice_period_id: 'adult', voice_slot_tag: slotTag() }
it('reuses a coordinated ready asset only after an exact provider GET', async () => {
  const f = await fixture({ getAsset: sharedAsset(7, 'adult', { assetName: readyAsset.name }) })
  const coordinator: VoiceCoordinator = { async request(request) {
    return readVoiceCoordination({ ...request, state: 'ready', asset: readyAsset }, request)
  } }
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, coordinator)).toMatchObject({ status: 'reuse_current',
    exclusive_registration: true, canonical_voice_asset_id: 7 })
  expect(f.requests.filter(row => row.startsWith('POST'))).toEqual([])
  expect(f.requests).toContain('GET /prod-api/aigc/asset/7')
})
it('refuses stale coordination whose provider URL no longer matches', async () => {
  const f = await fixture({ getAsset: sharedAsset(7, 'adult', { assetName: readyAsset.name, url: 'https://media.example/changed.wav' }) })
  const coordinator: VoiceCoordinator = { async request(request) {
    return readVoiceCoordination({ ...request, state: 'ready', asset: readyAsset }, request)
  } }
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, coordinator)).toMatchObject({
    status: 'voice_reference_pending', reason_code: 'asset-identity-changed', reuse_current: false, verified_readback: false })
  expect(f.requests.filter(row => row.startsWith('POST'))).toEqual([])
})
it('returns available coordination as a pending registration without a local claim', async () => {
  const f = await fixture()
  const coordinator: VoiceCoordinator = { async request(request) {
    return readVoiceCoordination({ ...request, state: 'available' }, request)
  } }
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, coordinator)).toMatchObject({ status: 'coordination_pending' })
  expect(await f.ledger.records()).toEqual([])
})
it('does not hide a coordinator scope contradiction', async () => {
  const f = await fixture()
  const coordinator: VoiceCoordinator = { async request() { throw new JubianError('CONTRACT_CHANGED', 'Scope mismatch') } }
  await expect(registerAudioAsset(f.client, f.ledger, sharedArgs, limits, coordinator)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
})
it('keeps a prior local claim read-only when shared coordination is unavailable', async () => {
  const f = await fixture({ pages: () => ({ total: 1, rows: [sharedAsset(7, 'adult', { assetName: readyAsset.name })] }) })
  await f.ledger.begin({ idempotencyKey: args.idempotency_key, method: 'asset_register', scriptId: 2708,
    requestSha256: bodyHash({ ...body, assetName: readyAsset.name }) })
  const coordinator: VoiceCoordinator = { async request() { throw new Error('Unavailable') } }
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, coordinator)).toMatchObject({
    replayed: true, created_asset_id: 7 })
  expect(f.requests.filter(row => row.startsWith('POST'))).toEqual([])
})
it.each([false, true])('abandons only an unused reserved lease after a late local claim; failure=%s', async (failure) => {
  const f = await fixture(), calls: string[] = []
  const coordinator: VoiceCoordinator = { async request(request) {
    calls.push(request.action)
    if (request.action === 'acquire') {
      await f.ledger.begin({ idempotencyKey: args.idempotency_key, method: 'asset_register', scriptId: 2708,
        requestSha256: bodyHash({ ...body, assetName: readyAsset.name }) })
      return readVoiceCoordination({ ...request, state: 'reserved', lease_id: 'a'.repeat(43), owner_operation: true }, request)
    }
    if (failure) throw new Error('Abandon reply lost')
    return readVoiceCoordination({ ...request, state: 'available' }, request)
  } }
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, coordinator)).toMatchObject({ replayed: true })
  expect(calls).toEqual(['acquire', 'abandon'])
  expect(f.requests.filter(row => row.startsWith('POST'))).toEqual([])
})
it('preserves a late ordinary local claim without invoking any coordinator', async () => {
  const f = await fixture()
  const original = f.ledger.beginChecked.bind(f.ledger)
  vi.spyOn(f.ledger, 'beginChecked').mockImplementationOnce(async (key, prepare) => {
    await f.ledger.begin({ idempotencyKey: key, method: 'asset_register', scriptId: 2708, requestSha256: bodyHash(body) })
    return await original(key, prepare)
  })
  expect(await registerAudioAsset(f.client, f.ledger, args, limits)).toMatchObject({ replayed: true })
  expect(f.requests.filter(row => row.startsWith('POST'))).toEqual([])
})
it.each(['not-ready', 'contract', 'unavailable'])('retains the original operation after completion failure %s', async (failure) => {
  const f = await fixture({ pages: read => ({ total: read === 1 ? 0 : 1,
    rows: read === 1 ? [] : [sharedAsset(7, 'adult', { assetName: readyAsset.name })] }) })
  const coordinator: VoiceCoordinator = { async request(request) {
    if (request.action === 'complete') {
      if (failure === 'not-ready') return readVoiceCoordination({ ...request, state: 'available' }, request)
      if (failure === 'contract') throw new JubianError('CONTRACT_CHANGED', 'Exact readback failed')
      throw new Error('Response lost')
    }
    return await permissiveCoordinator().request(request)
  } }
  const result = registerAudioAsset(f.client, f.ledger, sharedArgs, limits, coordinator)
  if (failure === 'unavailable') expect(await result).toMatchObject({ created_asset_id: 7, coordination_state: 'submitted' })
  else await expect(result).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.requests.filter(row => row.startsWith('POST'))).toHaveLength(1)
})

it.each(['sign-in-required', 'account-changed', 'not-configured', 'network', 'unavailable'] as const)('keeps %s pending local to registration before a start permission', async (reason) => {
  const f = await fixture()
  const coordinator: VoiceCoordinator = { async request(request) {
    if (request.action === 'acquire') return await permissiveCoordinator().request(request)
    throw new VoiceCoordinationUnavailableError(reason)
  } }
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, coordinator)).toMatchObject({
    status: 'coordination_unavailable', reason_code: reason, work_can_continue: true, failure_scope: 'voice_registration',
    submission_attempted: false, retry_registration: false, original_idempotency_key: args.idempotency_key,
  })
  expect(f.requests.filter(row => row.startsWith('POST'))).toEqual([])
  expect(await f.ledger.find(args.idempotency_key)).toMatchObject({ outcome: 'unknown' })
})


it('does not reuse or automatically replace a shared slot that the list explicitly marks deleted', async () => {
  const deleted = sharedAsset(13, 'adult', { delFlag: '1' })
  const f = await fixture({ pages: () => ({ total: 1, rows: [deleted] }), getAsset: { ...deleted, delFlag: '0' } })
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits)).toMatchObject({ status: 'voice_reference_pending',
    reason_code: 'asset-deleted', pending_asset_id: 13, reuse_current: false, shared_slot_verified: false,
    submission_attempted: false, work_can_continue: true })
  expect(f.requests).toEqual(['GET /prod-api/aigc/asset/list'])
  expect(await f.ledger.records()).toEqual([])
})

it('excludes a deleted lower ID and verifies the next active candidate through its exact detail endpoint', async () => {
  const f = await fixture({ pages: (_read, page) => ({ total: 2,
    rows: [page === 1 ? sharedAsset(13, 'adult', { delFlag: 1 }) : sharedAsset(14)] }) })
  const result = await registerAudioAsset(f.client, f.ledger, sharedArgs, limits)
  expect(result).toMatchObject({ canonical_voice_asset_id: 14, shared_slot_verified: true, reuse_current: true,
    canonical_voice_asset: { liveness: 'active' } })
  expect(f.requests).toContain('GET /prod-api/aigc/asset/14')
  expect(f.requests).not.toContain('GET /prod-api/aigc/asset/13')
  expect(f.requests.some(row => row.startsWith('POST'))).toBe(false)
})

const failedDetails: { label: string; detail: unknown; protocol?: boolean; reason?: string }[] = [
  { label: 'missing', detail: null, reason: 'asset-missing' },
  { label: 'deleted', detail: sharedAsset(13, 'adult', { delFlag: '1' }), reason: 'asset-deleted' },
  { label: 'absent flag', detail: sharedAsset(13, 'adult', { delFlag: undefined }), reason: 'asset-liveness-unknown' },
  { label: 'ambiguous flag', detail: sharedAsset(13, 'adult', { delFlag: 'pending' }), reason: 'asset-liveness-unknown' },
  { label: 'null deleted flag', detail: sharedAsset(13, 'adult', { deleted: null }), reason: 'asset-liveness-unknown' },
  { label: 'conflicting deleted flag', detail: sharedAsset(13, 'adult', { deleted: true }), reason: 'asset-deleted' },
  { label: 'URL drift', detail: sharedAsset(13, 'adult', { url: 'https://media.example/replaced.wav' }), reason: 'asset-identity-changed' },
  { label: 'name drift', detail: sharedAsset(13, 'adult', { assetName: `新的声音 ${slotTag()}` }), reason: 'asset-identity-changed' },
  { label: 'period drift', detail: sharedAsset(13, 'child'), reason: 'asset-identity-changed' },
  { label: 'character drift', detail: sharedAsset(13, 'adult', { assetName: `声音 ${encodeVoiceSlot(2708, 'other', 'adult')}` }),
    reason: 'asset-identity-changed' },
  { label: 'project drift', detail: sharedAsset(13, 'adult', { scriptId: 2709 }), protocol: true },
  { label: 'category drift', detail: sharedAsset(13, 'adult', { assetType: 1 }), protocol: true },
  { label: 'asset ID drift', detail: sharedAsset(14), protocol: true },
]
it.each(failedDetails)('requires exact active detail before existing-slot reuse: $label', async ({ detail, protocol, reason }) => {
  const f = await fixture({ pages: () => ({ total: 1, rows: [sharedAsset(13)] }), getAsset: detail })
  const result = registerAudioAsset(f.client, f.ledger, sharedArgs, limits)
  if (protocol) await expect(result).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  else expect(await result).toMatchObject({ status: 'voice_reference_pending', reason_code: reason, reuse_current: false,
    verified_readback: false, shared_slot_verified: false, submission_attempted: false, retry_registration: false,
    canonical_voice_asset_id: null, work_can_continue: true, failure_scope: 'voice_registration', original_idempotency_key: args.idempotency_key })
  expect(f.requests).toEqual(['GET /prod-api/aigc/asset/list', 'GET /prod-api/aigc/asset/13'])
  expect(await f.ledger.records()).toEqual([])
})

it('does not turn an unknown list flag into a verified current voice without active detail evidence', async () => {
  const unknown = sharedAsset(13, 'adult', { delFlag: undefined })
  const f = await fixture({ pages: () => ({ total: 1, rows: [unknown] }) })
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits)).toMatchObject({ status: 'voice_reference_pending',
    reason_code: 'asset-liveness-unknown', work_can_continue: true, reuse_current: false })
  expect(f.requests.filter(row => row.startsWith('POST'))).toEqual([])
})

it('allows unknown list liveness to be resolved by exact affirmative provider detail', async () => {
  const f = await fixture({ pages: () => ({ total: 1, rows: [sharedAsset(13, 'adult', { delFlag: undefined })] }),
    getAsset: sharedAsset(13, 'adult', { delFlag: 0 }) })
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits)).toMatchObject({ canonical_voice_asset_id: 13,
    shared_slot_verified: true, verified_readback: true, canonical_voice_asset: { liveness: 'active' } })
  expect(f.requests.filter(row => row.startsWith('POST'))).toEqual([])
})

it.each(['1', 'pending'])('does not adopt a coordinated ready asset whose detail deletion evidence is %s', async (delFlag) => {
  const f = await fixture({ getAsset: sharedAsset(7, 'adult', { assetName: readyAsset.name, delFlag }) })
  const coordinator: VoiceCoordinator = { async request(request) {
    return readVoiceCoordination({ ...request, state: 'ready', asset: readyAsset }, request)
  } }
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, coordinator)).toMatchObject({ status: 'voice_reference_pending',
    reason_code: delFlag === '1' ? 'asset-deleted' : 'asset-liveness-unknown', reuse_current: false, submission_attempted: false })
  expect(f.requests.filter(row => row.startsWith('POST'))).toEqual([])
})


it('keeps acquisition account/network failure scoped without sending registration', async () => {
  const f = await fixture()
  const coordinator: VoiceCoordinator = { async request() { throw new VoiceCoordinationUnavailableError('network') } }
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, coordinator)).toMatchObject({
    status: 'coordination_unavailable', reason_code: 'network', work_can_continue: true, submission_attempted: false })
  expect(f.requests.filter(row => row.startsWith('POST'))).toEqual([])
})

it('retains the created receipt and original key when post-send voice liveness remains unverified', async () => {
  const f = await fixture({
    pages: read => ({ total: read === 1 ? 0 : 1, rows: read === 1 ? [] : [sharedAsset(7, 'adult', { assetName: readyAsset.name })] }),
    getAsset: sharedAsset(7, 'adult', { assetName: readyAsset.name, delFlag: undefined }),
  })
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, permissiveCoordinator())).toMatchObject({
    status: 'voice_reference_pending', outcome: 'accepted', reason_code: 'asset-liveness-unknown', canonical_voice_asset_id: null,
    registration_created_asset_id: 7, submission_attempted: true, replayed: false, reuse_current: false,
    original_idempotency_key: args.idempotency_key, work_can_continue: true })
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, permissiveCoordinator())).toMatchObject({
    status: 'voice_reference_pending', registration_created_asset_id: 7, submission_attempted: false, replayed: true })
  expect(f.requests.filter(row => row.startsWith('POST'))).toHaveLength(1)
})


it('retains the lowest deleted ID for exact reconciliation rather than guessing a replacement', async () => {
  const f = await fixture({ pages: (_read, page) => ({ total: 2, rows: [sharedAsset(page === 1 ? 17 : 13, 'adult', { delFlag: '1' })] }) })
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits)).toMatchObject({ status: 'voice_reference_pending',
    reason_code: 'asset-deleted', pending_asset_id: 13, canonical_voice_asset_id: null, reuse_current: false, submission_attempted: false })
  expect(f.requests.some(row => row.startsWith('POST'))).toBe(false)
})

it('does not publish a newly registered deleted list row as a ready shared voice even if detail claims active', async () => {
  const f = await fixture({ pages: read => ({ total: read === 1 ? 0 : 1,
    rows: read === 1 ? [] : [sharedAsset(7, 'adult', { assetName: readyAsset.name, delFlag: '1' })] }),
  getAsset: sharedAsset(7, 'adult', { assetName: readyAsset.name }) })
  const coordinator = permissiveCoordinator(), calls: string[] = []
  const tracked: VoiceCoordinator = { async request(request) { calls.push(request.action); return await coordinator.request(request) } }
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, tracked)).toMatchObject({ status: 'voice_reference_pending',
    reason_code: 'asset-deleted', pending_asset_id: 7, registration_created_asset_id: 7, submission_attempted: true })
  expect(calls).not.toContain('complete')
  expect(f.requests.filter(row => row.startsWith('POST'))).toHaveLength(1)
})


it('does not reuse a previously coordinated active detail when the fresh reconciliation list marks that ID deleted', async () => {
  const f = await fixture({ pages: () => ({ total: 1, rows: [sharedAsset(7, 'adult', { assetName: readyAsset.name, delFlag: '1' })] }),
    getAsset: sharedAsset(7, 'adult', { assetName: readyAsset.name }) })
  await f.ledger.begin({ idempotencyKey: args.idempotency_key, method: 'asset_register', scriptId: 2708,
    requestSha256: bodyHash({ ...body, assetName: readyAsset.name }) })
  const coordinator: VoiceCoordinator = { async request(request) {
    return readVoiceCoordination({ ...request, state: 'ready', asset: readyAsset }, request)
  } }
  expect(await registerAudioAsset(f.client, f.ledger, sharedArgs, limits, coordinator)).toMatchObject({
    status: 'voice_reference_pending', reason_code: 'asset-deleted', pending_asset_id: 7, canonical_voice_asset_id: null,
    reuse_current: false, submission_attempted: false, replayed: true })
  expect(f.requests.filter(row => row.startsWith('POST'))).toEqual([])
})

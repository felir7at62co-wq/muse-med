import assert from 'node:assert/strict'
import test from 'node:test'
import { install as installRequests } from '../src/host/requests.js'
import { createWebSubmissions } from '../src/host/web-submissions.js'

const input = { clientRequestId: 'phone-message-1', sessionId: 'writer', text: 'Collect the public shortlist.' }

function world() {
  const disk = { state: {}, events: new Map() }
  const prompts = []
  let saves = 0
  let failSave = -1
  let failFlush = false
  let beforePrompt = async () => {}
  const boot = (targetOf = id => id) => {
    const agents = new Map()
    const agentOf = id => {
      if (!agents.has(id)) agents.set(id, { session: { id }, inbox: { nextStep: [], nextTurn: [] } })
      return agents.get(id)
    }
    const rt = {
      state: structuredClone(disk.state),
      own: (object, key) => Object.hasOwn(object, key) ? object[key] : undefined,
      readOnly: () => undefined,
      warn() {},
      save: async () => {
        if (++saves === failSave) throw new Error('Team persistence unavailable')
        disk.state = structuredClone(rt.state)
      },
      ensureCapabilities: async () => {},
      resolveAgent: async id => agentOf(id),
      eventsBackwards: async function* (id) { yield* [...(disk.events.get(id) ?? [])].reverse() },
      ctx: {
        sessionController: {
          prompt: async request => {
            await beforePrompt()
            prompts.push(request)
            agentOf(request.sessionId).inbox.nextTurn.push({
              content: request.content, source: { kind: 'user', rpcId: request.requestId },
            })
            return { accepted: true }
          },
        },
        sessions: {
          flush: async session => {
            if (failFlush) throw new Error('Session persistence unavailable')
            disk.events.set(session.id, agentOf(session.id).inbox.nextTurn.map(data => ({ type: 'user/message', data })))
          },
        },
      },
    }
    installRequests(rt)
    return { rt, submissions: createWebSubmissions(rt, targetOf), agentOf }
  }
  return {
    boot, disk, prompts,
    failSaveAt: value => { failSave = value },
    failFlush: value => { failFlush = value },
    beforePrompt: value => { beforePrompt = value },
  }
}

test('retries share one native prompt and retain only a fingerprint in the team ledger', async () => {
  const w = world()
  const { submissions } = w.boot()
  const first = await submissions.send(input)
  assert.deepEqual(first, { accepted: true, status: 'accepted', clientRequestId: input.clientRequestId, sessionId: 'writer' })
  assert.deepEqual(await submissions.send(input), first)
  assert.deepEqual(await submissions.lookup(input), first)
  assert.equal(w.prompts.length, 1)
  assert.equal(w.prompts[0].requestId, `muse-web:${input.clientRequestId}`)
  assert.equal(JSON.stringify(w.disk.state).includes(input.text), false)
})

test('concurrent mobile sends wait for the same admission', async () => {
  const w = world()
  let release
  const hold = new Promise(resolve => { release = resolve })
  let started
  const ready = new Promise(resolve => { started = resolve })
  w.beforePrompt(async () => { started(); await hold })
  const { submissions } = w.boot()
  const first = submissions.send(input)
  await ready
  const second = submissions.send(input)
  release()
  assert.deepEqual(await first, await second)
  assert.equal(w.prompts.length, 1)
})

test('a request identifier cannot be reused for other text or another recipient', async () => {
  const w = world()
  const { submissions } = w.boot()
  await submissions.send(input)
  for (const changed of [{ ...input, text: 'Download all episodes.' }, { ...input, sessionId: 'another-writer' }]) {
    await assert.rejects(submissions.send(changed), { code: 'bot/submission-conflict' })
    await assert.rejects(submissions.lookup(changed), { code: 'bot/submission-conflict' })
  }
  assert.equal(w.prompts.length, 1)
})

test('a restart returns a settled receipt without another prompt', async () => {
  const w = world()
  const first = await w.boot().submissions.send(input)
  const restarted = w.boot().submissions
  assert.deepEqual(await restarted.lookup(input), first)
  assert.deepEqual(await restarted.send(input), first)
  assert.equal(w.prompts.length, 1)
})

test('native durable input reconciles a lost team receipt after a restart', async () => {
  const w = world()
  w.failSaveAt(2)
  await w.boot().submissions.send(input)
  assert.equal(Object.values(w.disk.state.requests)[0].outcome, 'pending')
  const restarted = w.boot().submissions
  assert.equal((await restarted.lookup(input)).status, 'accepted')
  assert.equal((await restarted.send(input)).status, 'accepted')
  assert.equal(w.prompts.length, 1)
})

test('an unknown admission never authorizes a replay when native input is absent', async () => {
  const w = world()
  w.failFlush(true)
  await assert.rejects(w.boot().submissions.send(input), /Session persistence unavailable/)
  w.failFlush(false)
  const restarted = w.boot().submissions
  assert.equal((await restarted.lookup(input)).status, 'unknown')
  assert.equal((await restarted.send(input)).status, 'unknown')
  assert.equal(w.prompts.length, 1)
})

test('a missing receipt is read without submitting, and malformed identifiers never persist', async () => {
  const w = world()
  const { submissions } = w.boot()
  assert.equal((await submissions.lookup(input)).status, 'missing')
  for (const clientRequestId of ['', '../elsewhere', 'x'.repeat(129), null]) {
    await assert.rejects(submissions.send({ ...input, clientRequestId }), { code: 'bot/invalid' })
  }
  assert.equal(w.prompts.length, 0)
  assert.equal(Object.keys(w.disk.state).length, 0)
})

test('the original recipient identifies the request after its chat moves to another part', async () => {
  const w = world()
  let target = 'writer-part-one'
  const first = await w.boot(() => target).submissions.send(input)
  target = 'writer-part-two'
  const restarted = w.boot(() => target).submissions
  assert.deepEqual(await restarted.send(input), first)
  assert.equal(w.prompts.length, 1)
})

test('failure to save the admission leaves no prompt and permits an original-ID retry', async () => {
  const w = world()
  w.failSaveAt(1)
  const { submissions } = w.boot()
  await assert.rejects(submissions.send(input), /Team persistence unavailable/)
  assert.equal((await submissions.lookup(input)).status, 'missing')
  assert.equal(w.prompts.length, 0)
  assert.equal((await submissions.send(input)).status, 'accepted')
  assert.equal(w.prompts.length, 1)
})

test('unavailable Session history keeps an uncertain admission unknown', async () => {
  const w = world()
  w.failFlush(true)
  await assert.rejects(w.boot().submissions.send(input), /Session persistence unavailable/)
  const { rt, submissions } = w.boot()
  rt.resolveAgent = async () => { throw new Error('Session writer unavailable') }
  rt.eventsBackwards = async function* () { yield await Promise.reject(new Error('Session read timed out')) }
  assert.equal((await submissions.lookup(input)).status, 'unknown')
  assert.equal((await submissions.send(input)).status, 'unknown')
  assert.equal(w.prompts.length, 1)
})

test('a read-only Host does not create an admission for a new mobile request', async () => {
  const w = world()
  const { rt, submissions } = w.boot()
  rt.readOnly = () => 'Another Host owns this team'
  assert.equal((await submissions.send(input)).status, 'unknown')
  assert.equal((await submissions.lookup(input)).status, 'missing')
  assert.equal(w.prompts.length, 0)
  assert.equal(Object.keys(w.disk.state).length, 0)
})

/** Bounded guardian frames and pipe closure never masquerade as a render result. */
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { guardianParsers } from '../src/episode-guardian-journal.ts'
import { bindGuardianInput, collectGuardianDiagnostic, collectGuardianReply } from '../src/episode-guardian-protocol.ts'

const request = guardianParsers.parseRequest({ version: 1, kind: 'run', identity: {
  attempt: '18e73e76-f213-4f7d-9b76-a8a96cd78b5f', execution: '6594c5bc-770f-4385-b27c-225bda901f42',
  rendererGeneration: '3491fbc4-a028-4f45-9e91-9b2cf70e777a', planSha256: 'a'.repeat(64),
  projectSha256: 'b'.repeat(64), configurationSha256: 'c'.repeat(64), descriptorSha256: 'd'.repeat(64),
} })
const reply = guardianParsers.parseReply({ version: 1, kind: 'result', identity: request.identity,
  result: { kind: 'drained', proof: { version: 1, kind: 'drained', identity: request.identity,
    guardianPid: 123, commands: 2, result: 'cancelled' } } })
const requestFrame = Buffer.from(JSON.stringify(request) + '\n')
const replyFrame = Buffer.from(JSON.stringify(reply) + '\n')
const previousIdentity = { ...request.identity, execution: '9a45ee11-648f-4579-b165-f354744890d5',
  descriptorSha256: 'e'.repeat(64) }
const foreignIdentity = { ...previousIdentity, attempt: 'a1dd0450-5156-4647-af36-acb27c7ffab9',
  projectSha256: 'f'.repeat(64) }
const proofFacts = { version: 1, kind: 'drained', identity: request.identity, guardianPid: 123, commands: 2 }
const completedProof = { ...proofFacts, result: 'completed', candidate: {
  outputSha256: 'a'.repeat(64), outputBytes: 42 } }
const previousCompletedProof = { ...completedProof, identity: previousIdentity }
const previousCancelledProof = { ...proofFacts, identity: previousIdentity, result: 'cancelled' }

it.each([
  ['drained proof from a foreign attempt', { kind: 'drained', proof: { ...completedProof, identity: foreignIdentity } }],
  ['drained proof from another physical execution', { kind: 'drained', proof: { ...completedProof, identity: previousIdentity } }],
  ['drained proof from another descriptor', { kind: 'drained', proof: { ...completedProof,
    identity: { ...request.identity, descriptorSha256: 'e'.repeat(64) } } }],
  ['reconcile carrying a failed proof', { kind: 'reconcile', proof: { ...previousCancelledProof, result: 'failed' } }],
  ['retry-required carrying a completed proof', { kind: 'retry-required', proof: previousCompletedProof }],
  ['unknown from a foreign attempt', { kind: 'unknown', diagnostic: 'No matching drain proof',
    previous: { version: 1, kind: 'running', identity: foreignIdentity, guardianPid: 123 } }],
  ['reconcile from a foreign attempt', { kind: 'reconcile', proof: { ...previousCompletedProof, identity: foreignIdentity } }],
  ['retry-required from a foreign attempt', { kind: 'retry-required', proof: { ...previousCancelledProof, identity: foreignIdentity } }],
] as const)('rejects a guardian reply with %s', async (_name, result) => {
  const input = new PassThrough(), parsed = collectGuardianReply(input, 4096, guardianParsers.parseReply)
  try {
    input.end(JSON.stringify({ version: 1, kind: 'result', identity: request.identity, result }) + '\n')
    await expect(parsed).rejects.toThrow('invalid or oversized reply')
  } finally { input.destroy() }
})

it.each([
  ['a completed previous execution', { kind: 'reconcile', proof: previousCompletedProof }],
  ['an unproven previous execution', { kind: 'unknown', diagnostic: 'No matching drain proof',
    previous: { version: 1, kind: 'running', identity: previousIdentity, guardianPid: 123 } }],
  ['a cancelled previous execution requiring explicit retry', { kind: 'retry-required', proof: previousCancelledProof }],
] as const)('accepts a guardian reply for %s in the same logical attempt', async (_name, result) => {
  const input = new PassThrough(), parsed = collectGuardianReply(input, 4096, guardianParsers.parseReply)
  try {
    const frame = { version: 1, kind: 'result', identity: request.identity, result }
    input.end(JSON.stringify(frame) + '\n')
    await expect(parsed).resolves.toEqual(frame)
  } finally { input.destroy() }
})

it('accepts a split request at the exact byte limit and keeps its cancellation pipe open', async () => {
  const input = new PassThrough()
  const binding = bindGuardianInput(input, requestFrame.length, guardianParsers.parseRequest)
  try {
    input.write(requestFrame.subarray(0, 17))
    input.write(requestFrame.subarray(17))
    await expect(binding.request).resolves.toEqual(request)
    expect(binding.signal.aborted).toBe(false)
    const ended = once(input, 'end')
    input.end()
    await ended
    expect(binding.signal.aborted).toBe(true)
  } finally { binding.cancel(); binding.dispose(); input.destroy() }
})

it.each(['end', 'destroy'] as const)('refuses an input already closed by %s', async (close) => {
  const input = new PassThrough()
  if (close === 'end') {
    const ended = once(input, 'end')
    input.resume(); input.end(); await ended
  } else {
    const closed = once(input, 'close')
    input.destroy(); await closed
  }
  const binding = bindGuardianInput(input, 4096, guardianParsers.parseRequest)
  try {
    expect(binding.signal.aborted).toBe(true)
    await expect(binding.request).rejects.toThrow('Host disconnected')
  } finally { binding.cancel(); binding.dispose(); input.destroy() }
})

it.each([
  ['malformed JSON', '{\n'],
  ['unrecognized field', JSON.stringify({ ...request, extra: true }) + '\n'],
  ['unrecognized version', JSON.stringify({ ...request, version: 2 }) + '\n'],
  ['invalid identity', JSON.stringify({ ...request, identity: { ...request.identity, attempt: '../other' } }) + '\n'],
  ['trailing bytes', JSON.stringify(request) + '\ntrailing'],
  ['two frames', JSON.stringify(request) + '\n' + JSON.stringify(request) + '\n'],
] as const)('aborts a request with %s before returning admission facts', async (_name, frame) => {
  const input = new PassThrough(), binding = bindGuardianInput(input, 4096, guardianParsers.parseRequest)
  try {
    input.end(frame)
    await expect(binding.request).rejects.toThrow(/invalid request|extra request bytes/u)
    expect(binding.signal.aborted).toBe(true)
  } finally { binding.cancel(); binding.dispose(); input.destroy() }
})

it('rejects an oversized partial request before a delimiter arrives', async () => {
  const input = new PassThrough(), binding = bindGuardianInput(input, 8, guardianParsers.parseRequest)
  try {
    input.write(Buffer.alloc(9, 32))
    await expect(binding.request).rejects.toThrow('request exceeds limit')
    expect(binding.signal.aborted).toBe(true)
  } finally { binding.cancel(); binding.dispose(); input.destroy() }
})

it('cancels a parsed request when a later request frame arrives', async () => {
  const input = new PassThrough(), binding = bindGuardianInput(input, 4096, guardianParsers.parseRequest)
  try {
    input.write(requestFrame)
    await binding.request
    input.write(requestFrame)
    expect(binding.signal.aborted).toBe(true)
  } finally { binding.cancel(); binding.dispose(); input.destroy() }
})

it.each([false, true])('cancels a pipe closed without end (request parsed: %s)', async (parsed) => {
  const input = new PassThrough(), binding = bindGuardianInput(input, 4096, guardianParsers.parseRequest)
  try {
    if (parsed) { input.write(requestFrame); await binding.request }
    const closed = once(input, 'close')
    input.destroy()
    await closed
    expect(binding.signal.aborted).toBe(true)
    if (!parsed) await expect(binding.request).rejects.toThrow()
  } finally { binding.cancel(); binding.dispose(); input.destroy() }
})

it('retires input cancellation listeners when their owner disposes the binding', async () => {
  const input = new PassThrough(), binding = bindGuardianInput(input, 4096, guardianParsers.parseRequest)
  try {
    input.write(requestFrame)
    await binding.request
    binding.dispose()
    const closed = once(input, 'close')
    input.destroy()
    await closed
    expect(binding.signal.aborted).toBe(false)
  } finally { binding.cancel(); binding.dispose(); input.destroy() }
})

it('rejects an incomplete request on EOF and a failed stdin stream', async () => {
  for (const failure of ['eof', 'error'] as const) {
    const input = new PassThrough(), binding = bindGuardianInput(input, 4096, guardianParsers.parseRequest)
    try {
      input.write(requestFrame.subarray(0, 20))
      if (failure === 'eof') input.end()
      else input.destroy(new Error('controlled stdin failure'))
      await expect(binding.request).rejects.toThrow(failure === 'eof' ? 'Host disconnected' : 'stdin failed')
      expect(binding.signal.aborted).toBe(true)
    } finally { binding.cancel(); binding.dispose(); input.destroy() }
  }
})

it('parses a split reply only after EOF at the exact byte limit', async () => {
  const input = new PassThrough(), parse = vi.fn(guardianParsers.parseReply)
  const result = collectGuardianReply(input, replyFrame.length, parse)
  try {
    input.write(replyFrame.subarray(0, 23))
    input.write(replyFrame.subarray(23))
    expect(parse).not.toHaveBeenCalled()
    input.end()
    await expect(result).resolves.toEqual(reply)
    expect(parse).toHaveBeenCalledOnce()
  } finally { input.destroy() }
})

it.each([
  ['missing delimiter', JSON.stringify(reply)],
  ['malformed JSON', '{\n'],
  ['trailing bytes', JSON.stringify(reply) + '\nextra'],
  ['two frames', JSON.stringify(reply) + '\n' + JSON.stringify(reply) + '\n'],
  ['unrecognized field', JSON.stringify({ ...reply, extra: true }) + '\n'],
  ['unrecognized version', JSON.stringify({ ...reply, version: 2 }) + '\n'],
  ['unrecognized result', JSON.stringify({ ...reply, result: { kind: 'success' } }) + '\n'],
] as const)('does not return a result for a reply with %s', async (_name, frame) => {
  const input = new PassThrough(), result = collectGuardianReply(input, 4096, guardianParsers.parseReply)
  try {
    input.end(frame)
    await expect(result).rejects.toThrow('invalid or oversized reply')
  } finally { input.destroy() }
})

it('keeps draining after an oversized reply and never parses its retained suffix', async () => {
  const input = new PassThrough(), parse = vi.fn(guardianParsers.parseReply)
  const result = collectGuardianReply(input, 8, parse)
  const rejected = expect(result).rejects.toThrow('invalid or oversized reply')
  try {
    input.write(Buffer.alloc(9, 32))
    input.write(replyFrame)
    const ended = once(input, 'end')
    input.end()
    await Promise.all([rejected, ended])
    expect(parse).not.toHaveBeenCalled()
    expect(input.readableLength).toBe(0)
  } finally { input.destroy() }
})

it.each([false, true])('rejects a reply pipe closed without EOF (complete frame: %s)', async (complete) => {
  const input = new PassThrough(), result = collectGuardianReply(input, 4096, guardianParsers.parseReply)
  const rejected = vi.fn()
  void result.catch(rejected)
  try {
    input.write(complete ? replyFrame : replyFrame.subarray(0, 20))
    const closed = once(input, 'close')
    input.destroy()
    await closed
    expect(rejected).toHaveBeenCalledOnce()
    await expect(result).rejects.toThrow()
  } finally { input.destroy() }
})

it('rejects a reply whose stream reports a transport error', async () => {
  const input = new PassThrough(), result = collectGuardianReply(input, 4096, guardianParsers.parseReply)
  try {
    input.destroy(new Error('controlled stdout failure'))
    await expect(result).rejects.toThrow('invalid or oversized reply')
  } finally { input.destroy() }
})

it('rejects a reply stream destroyed before its collector was attached', async () => {
  const input = new PassThrough(), closed = once(input, 'close')
  input.destroy()
  await closed
  await expect(collectGuardianReply(input, 4096, guardianParsers.parseReply)).rejects.toThrow('invalid or oversized reply')
})

it('retains only the configured diagnostic byte tail through chunks and stream failure', async () => {
  const input = new PassThrough(), tail = collectGuardianDiagnostic(input, 5)
  try {
    input.write('ab')
    expect(tail()).toBe('ab')
    input.write('cdef')
    expect(tail()).toBe('bcdef')
    input.write('0123456789')
    expect(tail()).toBe('56789')
    const closed = new Promise<void>((resolve) => { input.once('close', resolve) })
    input.destroy(new Error('controlled diagnostic failure'))
    await closed
    expect(tail()).toBe('56789')
  } finally { input.destroy() }
})

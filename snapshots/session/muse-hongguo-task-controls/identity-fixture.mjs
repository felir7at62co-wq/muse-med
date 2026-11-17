/** Deterministic task identities and timestamps; media digests retain the real crypto implementation. */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated scenario lifetime.
 * @param {URL} clientURL - The real plugin client's module URL.
 * @param {{ identity: string, stamp: number }} options - Scenario identity and fixed timestamp.
 * @returns {void} Installs effects before the task module is imported.
 */
export function installHongguoTaskIdentity(ctx, clientURL, { identity, stamp }) {
  assert.match(identity, /^[a-z0-9-]+$/)
  const tasksURL = new URL('./tasks.js', clientURL)
  const moduleText = `
import assert from 'node:assert/strict';
import { createHash as actualHash } from 'node:crypto';
export * from 'node:crypto';
let sequence = 0;
export function randomUUID() {
  const hex = actualHash('sha256').update(${JSON.stringify(identity)} + ':' + (++sequence)).digest('hex');
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20,32);
}
export function createHash(algorithm) {
  assert.equal(algorithm, 'sha256');
  let input;
  return { update(value) { assert.equal(input, undefined); assert.equal(typeof value, 'string'); input = value; return this; },
    digest(encoding) {
      assert.equal(encoding, 'hex');
      const parts = input.split('\\0');
      assert.equal(parts.length, 3);
      assert.match(parts[0], /^(session|cli):/);
      assert.ok(parts[1].length > 0);
      return actualHash('sha256').update(${JSON.stringify(identity)}+'\\0'+parts[2]).digest('hex');
    } };
}
`
  const cryptoURL = `data:text/javascript,${encodeURIComponent(moduleText)}`
  ctx.effect(() => {
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === 'node:crypto' && context.parentURL === tasksURL.href) return { url: cryptoURL, shortCircuit: true }
      return nextResolve(specifier, context)
    } })
    return () => hooks.deregister()
  }, 'hongguo-task-fixture.task-identities')
  ctx.effect(() => {
    const priorDate = globalThis.Date
    class FixtureDate extends priorDate {
      constructor(...args) { if (args.length === 0) super(stamp); else super(...args) }
      static now() { return stamp }
    }
    globalThis.Date = FixtureDate
    return () => { globalThis.Date = priorDate }
  }, 'hongguo-task-fixture.clock')
}

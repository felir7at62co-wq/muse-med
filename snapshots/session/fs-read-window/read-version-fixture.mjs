/** Give the read-only paginated source a deterministic provider version for replay. */
import { basename } from 'node:path'
export const name = 'read-version-fixture'
export const inject = ['fs']
/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped headless profile context. */
export function apply(ctx) {
  ctx.effect(() => {
    const stat = ctx.fs.stat.bind(ctx.fs)
    ctx.fs.stat = async (target, signal) => {
      const info = await stat(target, signal)
      return info && basename(target.displayPath) === 'big.txt' ? { ...info, version: 'fixture-big-text-v1' } : info
    }
    return () => { ctx.fs.stat = stat }
  })
}

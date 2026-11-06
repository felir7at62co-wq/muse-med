/** Source-fixture-only mutation before the unchanged real worker validates staged files. */
import { readFile, appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Worker from '../../src/episode-render-worker.ts'

export const name = 'approved-episode-tamper-worker-fixture'
export const inject = ['subprocess', 'appReady', 'appExit', 'cmdlineArgs']

/** Corrupt one private captured font and observe every call through the actual media seam. */
export async function apply(ctx, config) {
  const descriptor = JSON.parse(await readFile(config.descriptorPath, 'utf8'))
  const font = descriptor.stagedFiles.find(file => file.path.startsWith(descriptor.config.fontsDir + '/'))
  if (font === undefined) throw new Error('Tamper fixture requires an actual captured private font')
  await appendFile(font.path, 'controlled private font mutation')
  const original = ctx.subprocess.spawn
  let calls = 0
  const observed = function (spec) { calls++; return original.call(this, spec) }
  ctx.subprocess.spawn = observed
  ctx.effect(() => async () => {
    if (ctx.subprocess.spawn === observed) ctx.subprocess.spawn = original
    await writeFile(join(descriptor.stageRoot, 'media-spawn-witness.json'), JSON.stringify({ calls }) + '\n', { flag: 'wx' })
  })
  Worker.apply(ctx, config)
}

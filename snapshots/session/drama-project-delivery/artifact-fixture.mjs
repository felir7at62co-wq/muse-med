/** Check real delivery outputs before projecting only this scenario's volatile paths and clock. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const subtitle = { font_family: 'Project font', font_size_px: 30, margin_bottom_px: 18 }
const audio = { master_gain: 1, bgm_gain: 0.1 }
const seedFiles = ['project_config.json', 'shots.json', 'source.mp4', 'source.srt', 'approved-bgm.wav']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

/**
 * @param {string} cwd - Scenario workspace.
 * @returns {Promise<object>} Input digests captured before tool execution.
 */
export async function captureInputs(cwd) {
  return Object.fromEntries(await Promise.all(seedFiles.map(async path => [path, sha256(await readFile(join(cwd, path)))])))
}

/**
 * @param {unknown} value - Complete tool result or artifact.
 * @param {string} cwd - Owned random workspace.
 * @returns {unknown} Same fields with only owned paths projected.
 */
export function projectDeliveryPaths(value, cwd) {
  if (typeof value === 'string') {
    const posix = cwd.split('\\').join('/')
    const escaped = posix.replace(/:/g, '\\:')
    let result = value.replaceAll(escaped, '{{cwd}}').replaceAll(cwd, '{{cwd}}').replaceAll(posix, '{{cwd}}')
    if (result.includes('{{cwd}}')) result = result.split('\\').join('/')
    return result.replace(/(\{\{cwd\}\}\/exports\/)\.drama-render-[^/]+/g, '$1.drama-render-{{staging}}')
  }
  if (Array.isArray(value)) return value.map(item => projectDeliveryPaths(item, cwd))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, projectDeliveryPaths(child, cwd)]))
  }
  return value
}

/** @param {object} input - Actual report, pre-tool digests and captured media commands. */
export async function verifyDeliveryArtifacts({ cwd, report, sourceHashes, commands }) {
  assert.deepEqual(await captureInputs(cwd), sourceHashes, 'tools must not overwrite the approved source/config/SRT/BGM')
  assert.equal(report.ok, true)
  assert.deepEqual(report.failures, [])
  assert.equal(report.project, cwd)
  const timeline = await readJson(join(cwd, 'editing/01-timeline.json'))
  assert.deepEqual(timeline, { clips: [{ shot: 1, start_us: 0, duration_us: 5000000 }], body_end: 5,
    delivery: { visual_medium: 'animation_3d', width: 480, height: 854, fps: 24, subtitle, audio } })
  const preview = report.render_preview
  assert.equal(preview.subtitle.font_family, 'Project font')
  assert.equal(preview.subtitle.font_size_design, 67.518)
  assert.equal(preview.subtitle.font_size_output_px, 30)
  assert.equal(preview.subtitle.margin_bottom_design, 41)
  assert.equal(preview.subtitle.margin_bottom_output_px, 18.217)
  assert.equal(preview.audio.master_gain, 1)
  assert.equal(preview.audio.bgm_gain, 0.1)
  assert.equal(preview.audio.bgm_path, join(cwd, 'approved-bgm.wav'))
  assert.equal(await readFile(join(cwd, 'video/01/shot_001.mp4'), 'utf8'), 'selected source video\n')
  assert.equal(await readFile(join(cwd, 'editing/01.srt'), 'utf8'), await readFile(join(cwd, 'source.srt'), 'utf8'))
  if (report.method !== 'render') return
  const ass = await readFile(join(cwd, 'exports/.render_cache/01/display.ass'), 'utf8')
  assert.ok(ass.includes('Style: Default,Project font,67.518,'), 'actual ASS must retain the project font and size')
  assert.ok(ass.includes('0,2,40,40,41,1'), 'actual ASS must retain the project margin')
  assert.ok(ass.includes('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,原文'))
  assert.ok(!ass.includes('内容由AI生成'), 'animation must not acquire the photorealistic ending mark')
  const mux = commands.filter(command => command.args.includes('-stream_loop'))
  assert.equal(mux.length, 1)
  assert.equal(mux[0].args[mux[0].args.indexOf('-filter_complex') + 1],
    '[1:a]apad,atrim=0:5.000000,volume=1[a0];[2:a]atrim=0:5.000000,volume=0.1[a1];'
    + '[a0][a1]amix=inputs=2:duration=longest:normalize=0,atrim=0:5.000000,alimiter=limit=0.95:level=false[a]')
  const burned = commands.filter(command => command.args.some(arg => arg.includes("ass='")))
  assert.equal(burned.length, 1)
  assert.ok(burned[0].args.some(arg => arg.includes('display.ass') && arg.endsWith('fps=24,setpts=N/(24*TB)')))
  assert.equal(await readFile(join(cwd, 'exports/candidate.mp4'), 'utf8'), 'fixture encoded media\n')
}

/** @param {object} input - Verified complete artifacts and report from the finished real tool. */
export async function projectDeliveryArtifacts({ cwd, report, commands, sourceHashes }) {
  const jsonPaths = ['editing/01-sources.json', 'exports/.render_cache/01/shot_001.mp4.identity', 'exports/candidate.mp4.source-record.json']
  const textPaths = ['exports/.render_cache/01/concat.txt', 'exports/.render_cache/01/render.log']
  const paths = [...jsonPaths, ...textPaths, 'editing/01-timeline.json', 'exports/.render_cache/01/display.ass']
  let evidence
  if (process.env.DSH_DELIVERY_RAW_EVIDENCE_DIR) {
    await mkdir(process.env.DSH_DELIVERY_RAW_EVIDENCE_DIR, { recursive: true })
    evidence = await mkdtemp(join(process.env.DSH_DELIVERY_RAW_EVIDENCE_DIR, 'delivery-session-'))
    for (const path of paths) {
      await mkdir(dirname(join(evidence, path)), { recursive: true })
      await copyFile(join(cwd, path), join(evidence, path))
    }
    await writeFile(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(join(evidence, 'media-commands.json'), `${JSON.stringify(commands, null, 2)}\n`)
    await writeFile(join(evidence, 'input-hashes.json'), `${JSON.stringify(sourceHashes, null, 2)}\n`)
    const exampleMode = process.env.DSH_EXAMPLE_MODE ?? 'src'
    const rendererEntry = new URL(exampleMode === 'lib'
      ? '../../../packages/drama/tool-episode-render/lib/index.js'
      : '../../../packages/drama/tool-episode-render/src/index.ts', import.meta.url)
    await writeFile(join(evidence, 'run-meta.json'), `${JSON.stringify({ exampleMode,
      rendererEntry: rendererEntry.href, rendererSha256: sha256(await readFile(rendererEntry)) }, null, 2)}\n`)
  }
  for (const path of jsonPaths) {
    const value = await readJson(join(cwd, path))
    if (path.endsWith('.source-record.json')) {
      assert.equal(new Date(value.rendered_at).toISOString(), value.rendered_at, 'source record clock must be an ISO instant')
      value.rendered_at = '2000-01-01T00:00:00.000Z'
    }
    const projected = projectDeliveryPaths(value, cwd)
    await writeFile(join(cwd, path), `${JSON.stringify(projected, null, 2)}\n`)
  }
  for (const path of textPaths) {
    const lines = (await readFile(join(cwd, path), 'utf8')).split('\n').map(line => {
      for (const key of ['bgm_plan=', 'render_preview=', 'delivery=']) {
        if (!line.startsWith(key)) continue
        const suffix = key === 'delivery=' ? ' add_watermark=false' : ''
        const payload = suffix ? line.slice(key.length, -suffix.length) : line.slice(key.length)
        return `${key}${JSON.stringify(projectDeliveryPaths(JSON.parse(payload), cwd))}${suffix}`
      }
      return projectDeliveryPaths(line, cwd)
    })
    await writeFile(join(cwd, path), lines.join('\n'))
  }
  await writeFile(join(cwd, 'media-commands.json'), `${JSON.stringify(projectDeliveryPaths(commands, cwd), null, 2)}\n`)
  if (evidence) {
    for (const path of [...seedFiles, 'audio', 'video', 'editing', 'exports', 'media-commands.json']) {
      await cp(join(cwd, path), join(evidence, 'projected-workspace', path), { recursive: true, errorOnExist: true })
    }
  }
}

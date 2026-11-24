/** Real upstream SQLite, assets and history with an isolated local model endpoint. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { requestLocalMini } from '../../../packages/drama/localminidrama/src/client.ts'

const root = resolve(process.env.LOCALMINIDRAMA_SOURCE || '.local/localminidrama')
const installed = existsSync(join(root, 'backend-node/node_modules/better-sqlite3'))

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}
async function close(server) {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}

test('studio persists editable projects, exact uploads and multiple generation versions', { skip: !installed, timeout: 45000 }, async () => {
  const originalCwd = process.cwd()
  const home = await mkdtemp(join(tmpdir(), 'muse-lmd-companion-'))
  const require = createRequire(join(root, 'backend-node/package.json'))
  let db
  let server
  let provider
  try {
    const storage = join(home, 'storage')
    await mkdir(join(home, 'configs'))
    const yaml = require('js-yaml')
    const config = yaml.load(await readFile(new URL('../config.yaml', import.meta.url), 'utf8'))
    config.database.path = join(home, 'drama.db')
    config.storage.local_path = storage
    config.storage.base_url = ''
    config.server.host = '127.0.0.1'
    await writeFile(join(home, 'configs/config.yaml'), yaml.dump(config))
    process.chdir(home)
    const appResult = require(join(root, 'backend-node/src/app.js')).createApp()
    db = appResult.db
    server = createServer(appResult.app)
    const url = await listen(server)
    appResult.config.storage.base_url = `${url}/static`
    config.storage.base_url = `${url}/static`
    await writeFile(join(home, 'configs/config.yaml'), yaml.dump(config))
    const api = async (path, method = 'GET', body) => {
      const signal = new AbortController().signal, operation = method === 'GET' ? {} : { operationId: randomUUID() }
      const edit = method === 'PUT' ? /^\/(dramas|storyboards)\/(\d+)(?:\/|$)/u.exec(path) : null
      if (edit) {
        const current = await requestLocalMini(url, { path: `/api/v1/muse/edit/${edit[1] === 'dramas' ? 'project' : 'storyboard'}/${edit[2]}`, method: 'GET' }, { timeoutMs: 10000, maxResponseBytes: 2e6 }, signal)
        body = { ...body, _muse_edit: current.muse_edit }
      }
      return await requestLocalMini(url, { path: `/api/v1${path}`, method, ...(body ? { body } : {}) }, { timeoutMs: 10000, maxResponseBytes: 2e6, ...operation }, signal)
    }
    const project = await api('/dramas', 'POST', { title: 'Muse 隔离验收', style: '3d', metadata: { aspect_ratio: '16:9' } })
    await api(`/dramas/${project.id}/episodes`, 'PUT', { episodes: [{ episode_number: 1, title: '第一集', script_content: '甲：保留原台词。' }] })
    await api(`/dramas/${project.id}/characters`, 'PUT', { characters: [{ name: '甲', appearance: '白色外套' }] })
    const saved = await api(`/dramas/${project.id}`)
    const episode = saved.episodes[0]
    assert.equal(episode.script_content, '甲：保留原台词。')
    const characters = await api(`/dramas/${project.id}/characters`)
    assert.equal(characters[0].name, '甲')
    const shot = await api('/storyboards', 'POST', { episode_id: episode.id, storyboard_number: 1, title: '初版', duration: 3, image_prompt: '原始参考', video_prompt: '原始动作' })
    await api(`/storyboards/${shot.id}`, 'PUT', { video_prompt: '修订动作' })
    assert.equal((await api(`/storyboards/${shot.id}`)).video_prompt, '修订动作')

    const form = new FormData()
    const png = await require('sharp')({ create: { width: 64, height: 64, channels: 3, background: '#4677aa' } }).png().toBuffer()
    form.set('drama_id', String(project.id))
    form.set('file', new Blob([png], { type: 'image/png' }), 'reference.png')
    const uploadResponse = await fetch(`${url}/api/v1/upload/image`, { method: 'POST', body: form })
    const upload = (await uploadResponse.json()).data
    assert.deepEqual(await readFile(join(storage, upload.local_path)), png)
    const asset = await api('/assets', 'POST', { drama_id: project.id, name: '已上传参考', type: 'image', url: upload.url, local_path: upload.local_path })
    assert.ok(asset.id)

    let providerCalls = 0
    let recoveredImageAvailable = false
    let clipAvailable = true
    provider = createServer(async (req, res) => {
      for await (const chunk of req) { /* Drain the real model request. */ }
      res.setHeader('content-type', 'application/json')
      if (req.method === 'POST' && req.url.includes('/images/generations')) {
        providerCalls++
        res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
      } else if (req.url === '/recover.png') {
        res.setHeader('content-type', recoveredImageAvailable ? 'image/png' : 'text/html')
        res.end(recoveredImageAvailable === 'truncated' ? png.subarray(0, 80) : recoveredImageAvailable ? png : Buffer.from('<html>not an image</html>'))
      } else if (req.method === 'POST' && req.url.includes('/contents/generations/tasks')) {
        res.end(JSON.stringify({ id: `fixture-video-${++videoCalls}` }))
      } else if (req.url.endsWith('/fixture.mp4')) {
        if (!clipAvailable) { res.statusCode = 503; res.end('temporarily unavailable'); return }
        if (clipAvailable === 'corrupt') { res.setHeader('content-type', 'text/html'); res.end('<html>not a video</html>'); return }
        if (clipAvailable === 'truncated') { const bytes = await readFile(clip); res.setHeader('content-type', 'video/mp4'); res.end(bytes.subarray(0, Math.floor(bytes.length * 0.7))); return }
        res.setHeader('content-type', 'video/mp4')
        res.end(await readFile(clip))
      } else {
        res.end(JSON.stringify({ id: 'fixture-video', status: 'succeeded', content: { video_url: `${providerUrl}/fixture.mp4` } }))
      }
    })
    const providerUrl = await listen(provider)
    const budget = await api('/muse/budget/projects/' + project.id)
    await api('/muse/budget/projects/' + project.id, 'PUT', { database_id: budget.database_id, operation_id: randomUUID(), expected_revision: budget.revision, currency: 'CNY', limit_minor: 10000, allow_estimates: true, allow_task_envelopes: false })
    for (const [service, providerName] of [['image', 'openai'], ['video', 'volcengine']]) {
      const id = 'companion-fixture-' + service
      await api('/muse/budget/catalog/' + id, 'PUT', { database_id: budget.database_id, id, operation_id: randomUUID(), expected_revision: 0, operator_accepted: true, service, provider: providerName, model: 'fixture-' + service, origin: providerUrl, currency: 'CNY', reserve_minor: 100, source: 'operator-entered', effective_at: '2026-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', estimate_kind: 'per-dispatch-estimate' })
    }
    const configured = await fetch(`${url}/api/v1/ai-configs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service_type: 'image', name: 'isolated-fixture', provider: 'openai', base_url: `${providerUrl}/v1`, api_key: 'local-fixture-only', model: ['fixture-image'], is_default: true }) })
    assert.equal(configured.status, 201)
    const generate = prompt => api('/images', 'POST', { drama_id: project.id, storyboard_id: shot.id, provider: 'openai', model: 'fixture-image', prompt, size: '1024x1024', quality: 'standard' })
    const first = await generate('第一版生成')
    const waitImage = async id => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const row = await api(`/images/${id}`)
        if (row.status === 'completed') return row
        if (row.status === 'failed') throw new Error(JSON.stringify(row))
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error('Image fixture did not settle')
    }
    const firstDone = await waitImage(first.id)
    const secondDone = await waitImage((await generate('第二版生成')).id)
    const history = await api(`/images?storyboard_id=${shot.id}&page_size=100`)
    assert.equal(history.items.length, 2)
    assert.equal(providerCalls, 2)
    assert.equal(firstDone.prompt, '第一版生成')
    assert.equal(secondDone.prompt, '第二版生成')
    assert.equal(secondDone.size, '1024x1024')
    assert.ok(existsSync(join(storage, firstDone.local_path)))
    assert.ok(existsSync(join(storage, secondDone.local_path)))
    await api(`/storyboards/${shot.id}`, 'PUT', { image_url: firstDone.image_url, local_path: firstDone.local_path })
    assert.equal((await api(`/images/${secondDone.id}`)).status, 'completed')
    assert.equal((await api(`/storyboards/${shot.id}`)).local_path, firstDone.local_path)
    await require('sharp')(join(storage, secondDone.local_path)).raw().toBuffer()

    // Recovery reuses a persisted supplier result and must not create another paid request.
    db.prepare("UPDATE image_generations SET status='failed', image_url=?, local_path=NULL WHERE id=?")
      .run(`${providerUrl}/recover.png`, secondDone.id)
    await assert.rejects(api(`/images/${secondDone.id}/resume-download`, 'POST', {}))
    assert.equal((await api(`/images/${secondDone.id}`)).status, 'failed')
    recoveredImageAvailable = 'truncated'
    await assert.rejects(api(`/images/${secondDone.id}/resume-download`, 'POST', {}))
    assert.equal((await api(`/images/${secondDone.id}`)).status, 'failed')
    recoveredImageAvailable = true
    const recoveredImage = await api(`/images/${secondDone.id}/resume-download`, 'POST', {})
    assert.equal(recoveredImage.status, 'completed')
    assert.ok(existsSync(join(storage, recoveredImage.local_path)))
    assert.equal(providerCalls, 2)
    assert.equal((await api(`/storyboards/${shot.id}`)).local_path, firstDone.local_path)

    const final = await fetch(`${url}/api/v1/episodes/${episode.id}/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(final.status, 500)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_merges').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_generations').get().count, 2)

    const { getFfmpegPath } = require(join(root, 'backend-node/src/utils/ffmpegPath.js'))
    const clip = join(home, 'fixture.mp4')
    const made = spawnSync(getFfmpegPath(), ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip], { encoding: 'utf8', timeout: 10000 })
    assert.equal(made.status, 0, made.stderr)
    let videoCalls = 0
    const videoConfigured = await fetch(`${url}/api/v1/ai-configs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service_type: 'video', name: 'isolated-video', provider: 'volcengine', base_url: `${providerUrl}/api/v3`, api_key: 'local-fixture-only', model: ['fixture-video'], is_default: true }) })
    assert.equal(videoConfigured.status, 201)
    const video = prompt => api('/videos', 'POST', { drama_id: project.id, storyboard_id: shot.id, provider: 'volcengine', model: 'fixture-video', prompt, duration: 3, aspect_ratio: '16:9', resolution: '480p', seed: 42 })
    const waitVideo = async id => {
      for (let attempt = 0; attempt < 500; attempt++) {
        const row = await api(`/videos/${id}`)
        if (row.status === 'completed') return row
        if (row.status === 'failed') throw new Error(JSON.stringify(row))
        await new Promise(resolve => setTimeout(resolve, 30))
      }
      throw new Error('Video fixture did not settle')
    }
    const videoA = await waitVideo((await video('动作 A')).id)
    const videoB = await waitVideo((await video('动作 B')).id)
    assert.equal(videoCalls, 2)
    assert.equal(videoA.seed, 42)
    assert.equal(videoB.prompt, '动作 B')
    assert.ok(videoA.provider_task_id)
    assert.ok(existsSync(join(storage, videoA.local_path)))
    assert.equal((await api(`/videos?storyboard_id=${shot.id}`)).items.length, 2)
    db.prepare("UPDATE video_generations SET status='failed', provider_task_id=NULL WHERE id=?").run(videoB.id)
    clipAvailable = false
    await api(`/videos/${videoB.id}/resume-poll`, 'POST', {})
    let failedDownload
    for (let attempt = 0; attempt < 200; attempt++) {
      const row = await api(`/videos/${videoB.id}`)
      if (row.status === 'failed') { failedDownload = row; break }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(failedDownload)
    assert.equal(failedDownload.video_url, `${providerUrl}/fixture.mp4`)
    assert.equal(failedDownload.can_resume_poll, true)
    clipAvailable = 'corrupt'
    await api(`/videos/${videoB.id}/resume-poll`, 'POST', {})
    let corruptDownload
    for (let attempt = 0; attempt < 200; attempt++) {
      const row = await api(`/videos/${videoB.id}`)
      if (row.status === 'failed') { corruptDownload = row; break }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(corruptDownload)
    assert.equal(corruptDownload.can_resume_poll, true)
    clipAvailable = 'truncated'
    await api(`/videos/${videoB.id}/resume-poll`, 'POST', {})
    let truncatedDownload
    for (let attempt = 0; attempt < 200; attempt++) {
      const row = await api(`/videos/${videoB.id}`)
      if (row.status === 'failed') { truncatedDownload = row; break }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(truncatedDownload)
    assert.equal(truncatedDownload.can_resume_poll, true)
    clipAvailable = true
    await api(`/videos/${videoB.id}/resume-poll`, 'POST', {})
    const recoveredVideo = await waitVideo(videoB.id)
    assert.ok(existsSync(join(storage, recoveredVideo.local_path)))
    assert.equal(videoCalls, 2)
    await api(`/storyboards/${shot.id}`, 'PUT', { video_url: `${url}/static/${videoA.local_path}` })
    const shot2 = await api('/storyboards', 'POST', { episode_id: episode.id, storyboard_number: 2, title: '第二镜', duration: 1 })
    await api(`/storyboards/${shot2.id}`, 'PUT', { video_url: `${url}/static/${videoB.local_path}` })
    const merge = await api(`/episodes/${episode.id}/finalize`, 'POST', {})
    let delivered
    for (let attempt = 0; attempt < 200; attempt++) {
      const row = await api(`/video-merges/${merge.merge_id}`)
      if (row.status === 'completed') { delivered = row; break }
      if (row.status === 'failed') throw new Error(JSON.stringify(row))
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.ok(delivered)
    assert.notEqual(delivered.merged_url, `/static/${videoA.local_path}`)
    const resultFile = join(storage, delivered.merged_url.replace(/^\/static\//, ''))
    const probe = spawnSync(getFfmpegPath(), ['-v', 'info', '-i', resultFile, '-f', 'null', '-'], { encoding: 'utf8', timeout: 10000 })
    assert.equal(probe.status, 0, probe.stderr)
    assert.match(probe.stderr, /Duration: 00:00:02\./)
    assert.ok((await api(`/episodes/${episode.id}/download`)).video_url)
  } finally {
    if (server) await close(server)
    if (provider) await close(provider)
    if (db) require(join(root, 'backend-node/src/db/index.js')).closeDb()
    process.chdir(originalCwd)
    await rm(home, { recursive: true, force: true })
  }
})

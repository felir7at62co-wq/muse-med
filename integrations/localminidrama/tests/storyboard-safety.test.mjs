/** Real pinned services and SQLite files, with fixture-local model responses and barriers. */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { planStoryboardCompatibility } from '../compatibility/storyboards.mjs'

const upstream = resolve(process.env.LOCALMINIDRAMA_SOURCE || '.local/localminidrama')
const installed = existsSync(join(upstream, 'backend-node/node_modules/better-sqlite3'))
const upstreamRequire = createRequire(join(upstream, 'backend-node/package.json'))
const log = { info() {}, warn() {}, error() {} }
const files = ['storyboardService.js', 'episodeStoryboardService.js', 'dramaService.js', 'videoService.js']
const caseOptions = { skip: !installed, timeout: 45000 }
// Retain native statements until source compilation ends; Windows finalizers require an active Node environment.
const databaseOwners = []
after(async () => {
  for (const owner of databaseOwners) {
    owner.db?.close()
    if (owner.linked) await unlink(owner.modules)
    await rm(owner.home, { recursive: true, force: true })
  }
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function fixture(t, patched = true) {
  const home = await mkdtemp(join(tmpdir(), 'muse-lmd-storyboard-'))
  const backend = join(home, 'backend-node')
  const modules = join(backend, 'node_modules')
  const owner = { home, modules, linked: false, db: null, statements: [] }
  databaseOwners.push(owner)
  let db
  let require
  const shutdown = deferred()
  const pending = []
  t.after(async () => {
    shutdown.resolve()
    await Promise.allSettled(pending)
  })
  await mkdir(backend)
  await cp(join(upstream, 'backend-node/src'), join(backend, 'src'), { recursive: true })
  await cp(join(upstream, 'backend-node/migrations'), join(backend, 'migrations'), { recursive: true })
  await cp(join(upstream, 'backend-node/package.json'), join(backend, 'package.json'))
  await symlink(join(upstream, 'backend-node/node_modules'), modules, 'junction')
  owner.linked = true
  for (const file of files) {
    const source = execFileSync('git', ['-C', upstream, 'show', `HEAD:backend-node/src/services/${file}`], { encoding: 'utf8' })
    await writeFile(join(backend, 'src/services', file), source)
  }
  if (patched) for (const [path, source] of planStoryboardCompatibility(home)) await writeFile(path, source)
  require = createRequire(join(backend, 'package.json'))
  const config = { app: { name: 'fixture' }, style: { default_style: '3d', default_video_ratio: '16:9' }, storage: { local_path: join(home, 'storage'), base_url: 'http://fixture.invalid/static' } }
  require(join(backend, 'src/config/index.js')).loadConfig = () => config
  // Migration logging is removed only from this private source copy.
  const migrationPath = join(backend, 'src/db/migrate.js')
  await writeFile(migrationPath, (await readFile(migrationPath, 'utf8')).replaceAll('console.log(', '(() => {})(').replaceAll('console.warn(', '(() => {})('))
  db = new (upstreamRequire('better-sqlite3'))(join(home, 'private.db'))
  owner.db = db
  const prepare = db.prepare.bind(db)
  db.prepare = (...args) => { const statement = prepare(...args); owner.statements.push(statement); return statement }
  require(migrationPath).runMigrationsAndEnsure(db)
  db.exec(`
    INSERT INTO dramas (id, title, style, metadata, created_at) VALUES (1, 'fixture', '3d', '{"storage_folder_label":"fixture"}', '2026-01-01'), (2, 'foreign', '3d', '{}', '2026-01-01');
    INSERT INTO episodes (id, drama_id, episode_number, title, script_content) VALUES (1, 1, 1, 'episode', '甲走进房间。'), (2, 2, 1, 'foreign', '另一集');
    INSERT INTO characters (id, drama_id, name, appearance) VALUES (1, 1, '甲', '白色外套'), (2, 2, '乙', '黑色外套'), (3, 1, '丙', '蓝色外套');
    INSERT INTO character_libraries (id, drama_id, name) VALUES (11, 1, '甲'), (12, 2, '乙'), (13, NULL, '丙');
    INSERT INTO scenes (id, drama_id, location) VALUES (1, 1, '客厅'), (2, 2, '外国场景');
    INSERT INTO props (id, drama_id, name) VALUES (1, 1, '杯子'), (2, 2, '外国道具');
    INSERT INTO storyboards (id, episode_id, storyboard_number, title, characters, image_url, local_path, video_url, created_at, updated_at) VALUES (1, 1, 1, '原镜头', '[1]', '/static/image.png', 'image.png', '/static/adopted.mp4', '2026-01-01', '2026-01-01');
    INSERT INTO storyboards (id, episode_id, storyboard_number, title, deleted_at) VALUES (9, 1, 9, '历史镜头', '2025-01-01');
    INSERT INTO storyboard_characters (storyboard_id, character_id) VALUES (1, 11);
    INSERT INTO storyboard_props (storyboard_id, prop_id) VALUES (1, 1);
    INSERT INTO frame_prompts (storyboard_id, frame_type, prompt) VALUES (1, 'first', '手工首帧');
    INSERT INTO image_generations (storyboard_id, drama_id, status, image_url, local_path) VALUES (1, 1, 'completed', '/static/image.png', 'image.png');
    INSERT INTO video_generations (id, storyboard_id, drama_id, status, video_url, local_path, created_at, completed_at) VALUES (1, 1, 1, 'completed', 'http://fixture.invalid/old.mp4', 'old.mp4', '2026-01-01', '2026-01-01');
  `)
  const services = file => require(join(backend, 'src/services', file))
  const tasks = services('taskService.js')
  const settled = new Map()
  const createTask = tasks.createTask
  tasks.createTask = (...args) => {
    const task = createTask(...args)
    settled.set(task.id, deferred())
    return task
  }
  for (const method of ['updateTaskResult', 'updateTaskError']) {
    const native = tasks[method]
    tasks[method] = (...args) => { const result = native(...args); settled.get(args[1])?.resolve(); return result }
  }
  const cancelTask = tasks.cancelTask
  tasks.cancelTask = (...args) => { const result = cancelTask(...args); settled.get(args[2])?.resolve(); return result }
  const ai = services('aiClient.js')
  const boards = services('storyboardService.js')
  const episodes = services('episodeStoryboardService.js')
  const generate = response => {
    ai.generateText = (...args) => Promise.race([
      response(...args),
      shutdown.promise.then(() => { throw new Error('fixture disposed') }),
    ])
    const task = episodes.generateStoryboard(db, log, 1, 'fixture-text', '3d', 2, 10, '16:9', true, false)
    pending.push(settled.get(task.task_id).promise)
    return { id: task.task_id, done: settled.get(task.task_id).promise }
  }
  const snapshot = () => Object.fromEntries(['dramas', 'episodes', 'characters', 'character_libraries', 'scenes', 'props', 'storyboards', 'storyboard_characters', 'storyboard_props', 'frame_prompts', 'image_generations', 'video_generations'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
  return { home, backend, db, config, require, services, tasks, boards, episodes, generate, snapshot }
}

const complete = title => JSON.stringify([{ shot_number: 1, title, action: '甲走进客厅', characters: [1], props: [1], scene_id: 1, duration: 5 }, { shot_number: 2, title: '第二镜', action: '甲放下杯子', characters: [{ id: 1, name: '甲' }], props: [], scene_id: 1, duration: 5 }])

test('planner is read-only and refuses drift in a replaced pinned implementation', caseOptions, async t => {
  const f = await fixture(t, false)
  const path = join(f.backend, 'src/services/episodeStoryboardService.js')
  const original = readFileSync(path, 'utf8')
  assert.equal(planStoryboardCompatibility(f.home).length, 4)
  assert.equal(readFileSync(path, 'utf8'), original)
  assert.throws(() => planStoryboardCompatibility(f.home, name => {
    const source = readFileSync(name, 'utf8')
    return name === path ? source.replace("  let streamThrottle = 0;", "  let streamThrottle = 1;") : source
  }), /does not match the pinned storyboard patch/)
})

test('streamed content followed by supplier failure preserves visible shots and every old relation', caseOptions, async t => {
  const f = await fixture(t)
  const before = f.snapshot()
  const entered = deferred()
  const release = deferred()
  const task = f.generate(async (_db, _log, _type, _user, _system, options) => {
    options.streamCallback?.(JSON.stringify([{ shot_number: 1, title: '不可提交', action: 'x'.repeat(600) }]))
    entered.resolve()
    await release.promise
    throw new Error('fixture supplier failure')
  })
  await entered.promise
  assert.equal(f.boards.getStoryboardById(f.db, 1).title, '原镜头')
  release.resolve()
  await task.done
  assert.equal(f.tasks.getTask(f.db, task.id).status, 'failed')
  assert.deepEqual(f.snapshot(), before)
})

test('invalid model output and failed second insertion never commit a partial replacement', caseOptions, async t => {
  const f = await fixture(t)
  for (const text of ['not JSON', '[]', '[null]', '[{"shot_number":0,"title":"bad"}]', '[{"shot_number":true,"title":"bad"}]', '[{"shot_number":1,"title":"bad","props":["bad"]}]', '[{"shot_number":1,"title":"bad","characters":[2]}]', '[{"shot_number":1,"title":"bad","scene_id":true}]', '[{"shot_number":1,"title":"bad","duration":"bad"}]']) {
    const before = f.snapshot()
    const task = f.generate(async () => text)
    await task.done
    assert.equal(f.tasks.getTask(f.db, task.id).status, 'failed', text)
    assert.deepEqual(f.snapshot(), before, text)
  }
  f.db.exec("CREATE TRIGGER reject_second_storyboard BEFORE INSERT ON storyboards WHEN NEW.storyboard_number = 2 BEGIN SELECT RAISE(ABORT, 'fixture second insert failed'); END;")
  const before = f.snapshot()
  const task = f.generate(async () => complete('第一镜'))
  await task.done
  assert.equal(f.tasks.getTask(f.db, task.id).status, 'failed')
  assert.match(f.tasks.getTask(f.db, task.id).error, /fixture second insert failed/)
  assert.deepEqual(f.snapshot(), before)
})

test('truncated generation whose continuation fails preserves original shots and links', caseOptions, async t => {
  const f = await fixture(t)
  const before = f.snapshot()
  let calls = 0
  const task = f.generate(async () => {
    if (++calls === 1) return '[{"shot_number":1,"title":"partial"},{"shot_number":2,"title":"unfinished'
    throw new Error('fixture continuation failure')
  })
  await task.done
  assert.equal(calls, 2)
  assert.equal(f.tasks.getTask(f.db, task.id).status, 'failed')
  assert.deepEqual(f.snapshot(), before)
})

test('complete replacement commits new shots together and preserves historical rows and asset links', caseOptions, async t => {
  const f = await fixture(t)
  const before = f.snapshot()
  const task = f.generate(async () => complete('采用的新镜头'))
  await task.done
  assert.equal(f.tasks.getTask(f.db, task.id).status, 'completed')
  const active = f.episodes.getStoryboardsForEpisode(f.db, 1)
  assert.equal(active.length, 2)
  assert.equal(active[0].title, '采用的新镜头')
  assert.notEqual(active[0].id, 1)
  assert.ok(f.db.prepare('SELECT deleted_at FROM storyboards WHERE id = 1').get().deleted_at)
  assert.equal(f.db.prepare('SELECT deleted_at FROM storyboards WHERE id = 9').get().deleted_at, '2025-01-01')
  for (const table of ['storyboard_characters', 'storyboard_props', 'frame_prompts', 'image_generations', 'video_generations']) {
    assert.deepEqual(f.db.prepare(`SELECT * FROM ${table} WHERE storyboard_id = 1 ORDER BY rowid`).all(), before[table])
  }
  assert.deepEqual(f.db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ?').all(active[0].id), [{ prop_id: 1 }])
  assert.deepEqual(f.db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id = ?').all(active[0].id), [{ character_id: 11 }])
})

test('edits, new shots and relation-only edits during generation reject replacement without discarding the edit', caseOptions, async t => {
  const f = await fixture(t)
  for (const edit of [
    () => f.boards.updateStoryboard(f.db, log, 1, { title: '用户正在编辑' }),
    () => f.boards.createStoryboard(f.db, log, { episode_id: 1, storyboard_number: 3, title: '用户新增' }),
    () => f.boards.saveFramePrompt(f.db, log, 1, 'first', '生成期间的新首帧'),
    () => f.db.prepare('DELETE FROM storyboard_props WHERE storyboard_id = 1').run(),
    () => f.db.prepare("UPDATE characters SET appearance = '用户修改造型' WHERE id = 1").run(),
    () => f.db.prepare("UPDATE scenes SET prompt = '用户修改场景' WHERE id = 1").run(),
    () => f.db.prepare("UPDATE props SET description = '用户修改道具' WHERE id = 1").run(),
    () => f.db.prepare("UPDATE character_libraries SET image_url = '用户修改角色库' WHERE id = 11").run(),
  ]) {
    const entered = deferred()
    const release = deferred()
    const task = f.generate(async () => { entered.resolve(); return release.promise })
    await entered.promise
    edit()
    const edited = f.snapshot()
    release.resolve(complete('过期生成'))
    await task.done
    assert.equal(f.tasks.getTask(f.db, task.id).status, 'failed')
    assert.match(f.tasks.getTask(f.db, task.id).error, /已修改/)
    assert.deepEqual(f.snapshot(), edited)
  }
})

test('overlapping generators commit one result and reject the stale result', caseOptions, async t => {
  const f = await fixture(t)
  const firstEntered = deferred()
  const firstRelease = deferred()
  const first = f.generate(async () => { firstEntered.resolve(); return firstRelease.promise })
  await firstEntered.promise
  const second = f.generate(async () => complete('先完成的版本'))
  await second.done
  const committed = f.snapshot()
  firstRelease.resolve(complete('迟到的版本'))
  await first.done
  assert.equal(f.tasks.getTask(f.db, second.id).status, 'completed')
  assert.equal(f.tasks.getTask(f.db, first.id).status, 'failed')
  assert.deepEqual(f.snapshot(), committed)
})

test('create persists character IDs and all advertised edits; bad and foreign references roll back', caseOptions, async t => {
  const f = await fixture(t)
  const fields = { episode_id: 1, storyboard_number: 2, title: 'new', description: '说明', location: '客厅', time: '白天', duration: 7, dialogue: '原台词', action: '拿杯子', result: '拿到杯子', atmosphere: '轻松', image_prompt: '画面', video_prompt: '动作', prop_ids: [1], scene_id: 1, narration: '旁白', status: 'ready' }
  const created = f.boards.createStoryboard(f.db, log, { ...fields, character_ids: [1, 3] })
  for (const [key, value] of Object.entries(fields)) assert.deepEqual(created[key], value, key)
  assert.deepEqual(created.characters, [1, 3])
  assert.equal(created.narration, '旁白')
  assert.deepEqual(f.db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id = ? ORDER BY character_id').all(created.id), [{ character_id: 11 }, { character_id: 13 }])
  const updated = f.boards.updateStoryboard(f.db, log, created.id, { storyboard_number: 4, lighting_style: 'soft', depth_of_field: 'shallow', emotion: '开心', emotion_intensity: 2 })
  assert.equal(updated.storyboard_number, 4)
  assert.equal(updated.lighting_style, 'soft')
  assert.equal(updated.depth_of_field, 'shallow')
  assert.equal(updated.emotion, '开心')
  assert.equal(updated.emotion_intensity, 2)
  for (const bad of [{ character_ids: [2] }, { character_ids: [true] }, { character_ids: [99] }, { characters: '[1,"bad"]' }, { characters: 'garbage' }, { scene_id: 2 }, { scene_id: true }, { scene_id: 99 }, { prop_ids: [2] }, { prop_ids: [true] }, { prop_ids: [99] }, { prop_ids: ['bad'] }, { storyboard_number: -1 }, { storyboard_number: true }]) {
    const before = f.snapshot()
    assert.throws(() => f.boards.updateStoryboard(f.db, log, created.id, { title: 'must not save', ...bad }), { code: 'BAD_REQUEST' })
    assert.deepEqual(f.snapshot(), before)
    assert.throws(() => f.boards.createStoryboard(f.db, log, { episode_id: 1, storyboard_number: 5, ...bad }), { code: 'BAD_REQUEST' })
    assert.deepEqual(f.snapshot(), before)
  }
  for (const episode_id of [true, [], {}, 99]) assert.throws(() => f.boards.createStoryboard(f.db, log, { episode_id, storyboard_number: 1 }), { code: 'BAD_REQUEST' })
  assert.equal(f.boards.createStoryboard(f.db, log, { episode_id: 1 }).duration, 0)
})

test('image adoption resolves paired first and last frame IDs and paths, clearing stale metadata for external URLs', caseOptions, async t => {
  const f = await fixture(t)
  f.db.prepare("INSERT INTO image_generations (id, storyboard_id, drama_id, status, frame_type, image_url, local_path) VALUES (2, 1, 1, 'completed', 'storyboard_first', 'http://fixture.invalid/provider-second.png', 'second.png'), (3, 1, 1, 'completed', 'storyboard_last', 'http://fixture.invalid/provider-last.png', 'last.png'), (4, 99, 2, 'completed', 'storyboard_first', 'http://fixture.invalid/foreign.png', 'foreign.png')").run()
  let shot = f.boards.updateStoryboard(f.db, log, 1, { image_url: 'http://fixture.invalid/provider-second.png', last_frame_image_url: 'http://fixture.invalid/provider-last.png' })
  assert.equal(shot.local_path, 'second.png')
  assert.equal(shot.first_frame_image_id, 2)
  assert.equal(shot.last_frame_local_path, 'last.png')
  assert.equal(shot.last_frame_image_id, 3)
  shot = f.boards.updateStoryboard(f.db, log, 1, { image_url: '/static/image.png', last_frame_image_url: 'https://other.fixture.invalid/external.png' })
  assert.equal(shot.local_path, 'image.png')
  assert.equal(shot.first_frame_image_id, 1)
  assert.equal(shot.last_frame_local_path, null)
  assert.equal(shot.last_frame_image_id, null)
  shot = f.boards.updateStoryboard(f.db, log, 1, { image_url: '/static/uploaded.png' })
  assert.equal(shot.local_path, 'uploaded.png')
  assert.equal(shot.first_frame_image_id, null)
  shot = f.boards.updateStoryboard(f.db, log, 1, { image_url: 'https://other.fixture.invalid/external.png' })
  assert.equal(shot.local_path, null)
  assert.equal(shot.first_frame_image_id, null)
  shot = f.boards.updateStoryboard(f.db, log, 1, { local_path: 'second.png' })
  assert.equal(shot.image_url, 'http://fixture.invalid/provider-second.png')
  assert.equal(shot.first_frame_image_id, 2)
  assert.throws(() => f.boards.updateStoryboard(f.db, log, 1, { first_frame_image_id: 4 }), { code: 'BAD_REQUEST' })
})

test('shared supplier image URLs use an explicit older path or generation ID and reject an ambiguous URL alone', caseOptions, async t => {
  const f = await fixture(t)
  const url = 'http://fixture.invalid/reused-image.png'
  f.db.prepare("INSERT INTO image_generations (id, storyboard_id, drama_id, status, frame_type, image_url, local_path) VALUES (2, 1, 1, 'completed', 'storyboard_first', ?, 'older-image.png'), (3, 1, 1, 'completed', 'storyboard_first', ?, 'newer-image.png')").run(url, url)
  let shot = f.boards.updateStoryboard(f.db, log, 1, { image_url: url, local_path: 'older-image.png', last_frame_image_url: url, last_frame_local_path: 'older-image.png' })
  assert.equal(shot.first_frame_image_id, 2)
  assert.equal(shot.local_path, 'older-image.png')
  assert.equal(shot.last_frame_image_id, 2)
  assert.equal(shot.last_frame_local_path, 'older-image.png')
  shot = f.boards.updateStoryboard(f.db, log, 1, { image_url: url, first_frame_image_id: 2, last_frame_image_url: url, last_frame_image_id: 2 })
  assert.equal(shot.first_frame_image_id, 2)
  assert.equal(shot.last_frame_image_id, 2)
  const before = f.snapshot()
  for (const req of [{ image_url: url }, { last_frame_image_url: url }]) {
    assert.throws(() => f.boards.updateStoryboard(f.db, log, 1, { title: 'must not save', ...req }), error => error.code === 'BAD_REQUEST' && /生成记录 ID.*local_url/.test(error.message))
    assert.deepEqual(f.snapshot(), before)
  }
  shot = f.boards.updateStoryboard(f.db, log, 1, { image_url: 'https://other.fixture.invalid/external.png', local_path: 'older-image.png' })
  assert.equal(shot.local_path, null)
  assert.equal(shot.first_frame_image_id, null)
})

test('finalization honors an older adopted video and never treats storyboard image local_path as video', caseOptions, async t => {
  const f = await fixture(t)
  const mergeService = f.services('videoMergeService.js')
  let scenes
  const finished = deferred()
  mergeService.create = (_db, _log, req) => { scenes = req.scenes; return { id: 123 } }
  mergeService.processVideoMerge = () => finished.resolve()
  f.db.prepare("INSERT INTO video_generations (storyboard_id, drama_id, status, video_url, local_path, created_at, completed_at) VALUES (1, 1, 'completed', 'http://fixture.invalid/newer.mp4', 'newer.mp4', '2099-01-01', '2099-01-01')").run()
  f.services('dramaService.js').finalizeEpisode(f.db, log, 1, 'http://fixture.invalid/static')
  await finished.promise
  assert.equal(scenes[0].video_url, 'http://fixture.invalid/static/adopted.mp4')
  const adopted = f.boards.updateStoryboard(f.db, log, 1, { video_url: 'http://fixture.invalid/old.mp4' })
  assert.equal(adopted.video_url, '/static/old.mp4')
  f.services('dramaService.js').finalizeEpisode(f.db, log, 1, 'http://fixture.invalid/static')
  assert.equal(scenes[0].video_url, 'http://fixture.invalid/static/old.mp4')
  await new Promise(resolve => setImmediate(resolve))
  f.db.prepare('UPDATE storyboards SET video_url = NULL WHERE id = 1').run()
  f.db.prepare('DELETE FROM video_generations').run()
  // The initial companion correction rejects missing shots; pristine upstream returns no merge.
  const result = f.services('dramaService.js').finalizeEpisode(f.db, log, 1, 'http://fixture.invalid/static')
  assert.equal(result.merge_id, null)
})

test('finalization normalizes an adopted local file after its generation history points to a recovered download', caseOptions, async t => {
  const f = await fixture(t)
  f.boards.updateStoryboard(f.db, log, 1, { video_url: '/static/old.mp4' })
  f.db.prepare("UPDATE video_generations SET local_path = 'recovered-download.mp4' WHERE id = 1").run()
  assert.equal(f.db.prepare("SELECT id FROM video_generations WHERE local_path = 'old.mp4'").get(), undefined)
  let scenes
  const finished = deferred()
  const mergeService = f.services('videoMergeService.js')
  mergeService.create = (_db, _log, req) => { scenes = req.scenes; return { id: 123 } }
  mergeService.processVideoMerge = () => finished.resolve()
  f.services('dramaService.js').finalizeEpisode(f.db, log, 1, f.config.storage.base_url + '/')
  await finished.promise
  assert.equal(scenes[0].video_url, f.config.storage.base_url + '/old.mp4')
  assert.equal(f.boards.getStoryboardById(f.db, 1).video_url, '/static/old.mp4')
})

test('cancellation before asynchronous generation starts never revives the task or changes shots', caseOptions, async t => {
  const f = await fixture(t)
  const before = f.snapshot()
  let calls = 0
  const task = f.generate(async () => { calls++; return complete('不可提交') })
  f.tasks.cancelTask(f.db, log, task.id)
  await task.done
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 0)
  assert.equal(f.tasks.getTask(f.db, task.id).status, 'failed')
  assert.deepEqual(f.snapshot(), before)
})

test('cancellation during generation prevents truncated continuation from reviving the task', caseOptions, async t => {
  const f = await fixture(t)
  const before = f.snapshot()
  const entered = deferred()
  const release = deferred()
  let calls = 0
  const task = f.generate(async () => { calls++; entered.resolve(); return release.promise })
  await entered.promise
  f.tasks.cancelTask(f.db, log, task.id)
  release.resolve('[{"shot_number":1,"title":"partial"},{"shot_number":2,"title":"unfinished')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(f.tasks.getTask(f.db, task.id).status, 'failed')
  assert.deepEqual(f.snapshot(), before)
})

test('video completion preserves an adoption made during generation and the storyboard image path', caseOptions, async t => {
  const f = await fixture(t)
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(Buffer.from('fixture video download')) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/new.mp4`
  const entered = deferred()
  const release = deferred()
  f.require(join(f.backend, 'src/utils/ffmpegPath.js')).hasLocalFfmpeg = () => false
  const client = f.services('videoClient.js')
  client.getDefaultVideoConfig = () => ({ provider: 'fixture' })
  client.callVideoApi = async () => { entered.resolve(); await release.promise; return { video_url: url } }
  f.db.prepare("INSERT INTO video_generations (id, storyboard_id, drama_id, prompt, model, provider, status) VALUES (2, 1, 1, 'fixture', 'fixture', 'fixture', 'pending')").run()
  const pending = f.services('videoService.js').processVideoGeneration(f.db, log, 2)
  await entered.promise
  f.boards.updateStoryboard(f.db, log, 1, { video_url: '/static/user-chosen.mp4' })
  release.resolve()
  await pending
  const shot = f.boards.getStoryboardById(f.db, 1)
  assert.equal(shot.video_url, '/static/user-chosen.mp4')
  assert.equal(shot.local_path, 'image.png')
  assert.equal(f.services('videoService.js').getById(f.db, 2).status, 'completed')
})

test('reused supplier video URLs retain the first local adoption and reject ambiguous legacy selections', caseOptions, async t => {
  const f = await fixture(t)
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(Buffer.from('fixture video download')) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/reused.mp4`
  f.require(join(f.backend, 'src/utils/ffmpegPath.js')).hasLocalFfmpeg = () => false
  const client = f.services('videoClient.js')
  client.getDefaultVideoConfig = () => ({ provider: 'fixture' })
  client.callVideoApi = async () => ({ video_url: url })
  const videos = f.services('videoService.js')
  f.db.prepare('UPDATE storyboards SET video_url = NULL WHERE id = 1').run()
  const generations = []
  for (const id of [2, 3]) {
    f.db.prepare("INSERT INTO video_generations (id, storyboard_id, drama_id, prompt, model, provider, status) VALUES (?, 1, 1, 'fixture', 'fixture', 'fixture', 'pending')").run(id)
    await videos.processVideoGeneration(f.db, log, id)
    generations.push(videos.getById(f.db, id))
    assert.equal(generations.at(-1).status, 'completed')
    assert.equal(generations.at(-1).video_url, url)
    assert.ok(generations.at(-1).local_path)
    assert.equal(f.boards.getStoryboardById(f.db, 1).video_url, '/static/' + generations[0].local_path)
  }
  assert.notEqual(generations[0].local_path, generations[1].local_path)
  const before = f.snapshot()
  assert.throws(() => f.boards.updateStoryboard(f.db, log, 1, { title: 'must not save', video_url: url }), error => error.code === 'BAD_REQUEST' && /local_url/.test(error.message))
  assert.deepEqual(f.snapshot(), before)
  f.boards.updateStoryboard(f.db, log, 1, { video_url: '/static/' + generations[1].local_path })
  const adopted = f.boards.updateStoryboard(f.db, log, 1, { video_url: f.config.storage.base_url + '/' + generations[0].local_path })
  assert.equal(adopted.video_url, '/static/' + generations[0].local_path)
  assert.equal(adopted.local_path, 'image.png')
  let scenes
  let merges = 0
  const mergeService = f.services('videoMergeService.js')
  mergeService.create = (_db, _log, req) => { scenes = req.scenes; merges++; return { id: 123 } }
  mergeService.processVideoMerge = () => {}
  const drama = f.services('dramaService.js')
  drama.finalizeEpisode(f.db, log, 1, f.config.storage.base_url)
  assert.equal(scenes[0].video_url, f.config.storage.base_url + '/' + generations[0].local_path)
  await new Promise(resolve => setImmediate(resolve))
  f.db.prepare('UPDATE storyboards SET video_url = ? WHERE id = 1').run(url)
  const legacy = f.snapshot()
  assert.throws(() => drama.finalizeEpisode(f.db, log, 1, f.config.storage.base_url), error => error.code === 'BAD_REQUEST' && /local_url/.test(error.message))
  assert.equal(merges, 1)
  assert.deepEqual(f.snapshot(), legacy)
})

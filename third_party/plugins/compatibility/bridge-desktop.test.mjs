import assert from 'node:assert/strict'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const source = join(import.meta.dirname, '../dsh-bridge')
const overlayPath = join(import.meta.dirname, 'bridge-desktop.mjs')

test('packs only the authenticated Muse transport and optional Feishu entry', async () => {
  assert.ok(existsSync(overlayPath), 'the reviewed bridge artifact overlay is required')
  const { applyBridgeDesktopCompatibility } = await import(pathToFileURL(overlayPath).href)
  const root = mkdtempSync(join(tmpdir(), 'muse-bridge-overlay-'))
  try {
    cpSync(source, root, { recursive: true })
    applyBridgeDesktopCompatibility(root)
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.equal(manifest.name, '@wenbin_wb/dsh-bridge')
    assert.equal(manifest.bin, undefined)
    assert.deepEqual(manifest.scripts, {})
    assert.equal(manifest.exports['./remote'], './lib/remote.mjs')
    assert.equal(manifest.exports['./client'], undefined)
    assert.equal(manifest.dependencies['@deepseek-ai/dsh-muse-account'], '0.2.1-alpha.1')
    assert.equal(manifest.dependencies['@deepseek-ai/schemastery'], '3.18.5-alpha.1')
    assert.match(readFileSync(join(root, 'LICENSE'), 'utf8'), /MIT License/)
    for (const path of ['lib/index.js', 'lib/remote.mjs', 'lib/upstream/tunnel-client.mjs']) {
      assert.ok(existsSync(join(root, path)), `${path} must ship`)
    }
    for (const path of ['lib/cloudflared-manager.mjs', 'lib/auth', 'client', 'scripts']) {
      assert.equal(existsSync(join(root, path)), false, `${path} must be excluded`)
    }
    assert.doesNotMatch(readFileSync(join(root, 'lib/index.js'), 'utf8'), /ProxyServer|AuthManager|cloudflared/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('refuses Feishu media outside the physical workspace before sending', async () => {
  const { applyBridgeDesktopCompatibility } = await import(pathToFileURL(overlayPath).href)
  const root = mkdtempSync(join(tmpdir(), 'muse-bridge-files-'))
  try {
    cpSync(source, root, { recursive: true })
    applyBridgeDesktopCompatibility(root)
    const { sendWorkspaceFile } = await import(pathToFileURL(join(root, 'lib/muse-feishu-files.mjs')).href)
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    writeFileSync(join(workspace, 'owned.txt'), 'owned')
    writeFileSync(join(outside, 'private.txt'), 'synthetic-private')
    symlinkSync(outside, join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    const sent = []
    const send = async file => { sent.push(file); return 'sent' }
    assert.equal(await sendWorkspaceFile({ cwd: workspace, filePath: join(workspace, 'owned.txt'), send }), 'sent')
    await assert.rejects(sendWorkspaceFile({ cwd: workspace, filePath: join(workspace, 'link/private.txt'), send }), /outside the active workspace/)
    await assert.rejects(sendWorkspaceFile({ cwd: workspace, filePath: join(outside, 'private.txt'), send }), /outside the active workspace/)
    assert.equal(sent.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('refuses changes to a retained Feishu module before packing', async () => {
  const { applyBridgeDesktopCompatibility } = await import(pathToFileURL(overlayPath).href)
  const root = mkdtempSync(join(tmpdir(), 'muse-bridge-review-'))
  try {
    cpSync(source, root, { recursive: true })
    appendFileSync(join(root, 'lib/feishu/node.js'), '\n// changed upstream source\n')
    assert.throws(() => applyBridgeDesktopCompatibility(root), /feishu\/node.js requires source review/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reads conversation metadata through current Host services', async () => {
  const { applyBridgeDesktopCompatibility } = await import(pathToFileURL(overlayPath).href)
  const root = mkdtempSync(join(tmpdir(), 'muse-bridge-storage-'))
  try {
    cpSync(source, root, { recursive: true })
    applyBridgeDesktopCompatibility(root)
    const storage = await import(pathToFileURL(join(root, 'lib/upstream/platform/dsh-storage.js')).href)
    const header = { id: 'owned-session', createdAt: '2026-09-30T00:00:00Z' }
    const ctx = {
      workspaceRegistry: { archivedSessionIds: ['archived'], list: async () => [{ id: 'workspace', path: '/workspace', sessionIds: ['owned-session'] }] },
      sessions: { list: () => [] },
      sessionPersistence: { list: async () => [{ header }] },
      sessionProjectionCache: { cachedSnapshot: actual => { assert.equal(actual, header); return { values: { title: 'Owned title' } } } },
    }
    assert.deepEqual(storage.getArchivedSessionIds(ctx), new Set(['archived']))
    assert.equal((await storage.getSessionProjCache(ctx))['owned-session'].rows.title.val, 'Owned title')
    assert.equal((await storage.getRegisteredWorkspaces(ctx))[0].id, 'workspace')
    assert.doesNotMatch(readFileSync(join(root, 'lib/upstream/platform/dsh-storage.js'), 'utf8'), /DSH_HOME|readFile|homedir/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

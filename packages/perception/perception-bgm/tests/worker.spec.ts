import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmotionWorker } from '../src/worker.ts'

let dir: string

async function writeWorker(body: string): Promise<string> {
  const path = join(dir, 'fake_worker.py')
  await writeFile(path, body, 'utf8')
  return path
}

const ECHO_WORKER = `
import json, sys
sys.stdout.write(json.dumps({"id": "__handshake__", "status": "ok",
                             "result": {"ready": True, "face": "emotion", "missing": []}}) + "\\n")
sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    req = json.loads(line)
    if req.get("method") == "boom":
        sys.stdout.write(json.dumps({"id": req["id"], "status": "error",
            "error": {"code": "ValueError", "message": "nope"}}) + "\\n")
    else:
        sys.stdout.write(json.dumps({"id": req["id"], "status": "ok",
            "result": {"echo": req.get("params")}}) + "\\n")
    sys.stdout.flush()
`

const DEAF_WORKER = `
import sys, time
sys.stdout.write("not json\\n"); sys.stdout.flush()
time.sleep(60)
`

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'perception-bgm-')) })

afterEach(() => { vi.unstubAllEnvs() })

describe('EmotionWorker', () => {
  it('keeps an explicitly deployed model cache independent of ambient cache locations', async () => {
    vi.stubEnv('HF_HOME', join(dir, 'ambient-home'))
    vi.stubEnv('HF_HUB_CACHE', join(dir, 'ambient-hub'))
    vi.stubEnv('TRANSFORMERS_CACHE', join(dir, 'ambient-transformers'))
    vi.stubEnv('HF_ENDPOINT', 'https://ambient.invalid')
    const script = await writeWorker(ECHO_WORKER)
    const launches: NodeJS.ProcessEnv[] = []
    const configured = {
      HF_HOME: join(dir, 'bundled-models'), HF_MODULES_CACHE: join(dir, 'writable-modules'),
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
    }
    const worker = new EmotionWorker({ pythonExecutable: 'python', scriptPath: script,
      env: configured, readyTimeoutMs: 20000, onLaunch: (_argv, env) => { launches.push(env) } })
    try {
      await worker.start()
      expect(launches[0]).toMatchObject(configured)
      for (const key of ['HF_HUB_CACHE', 'TRANSFORMERS_CACHE', 'HF_ENDPOINT']) expect(launches[0]?.[key]).toBeUndefined()
      expect(await worker.call('analyse', {})).toEqual({ echo: {} })
    } finally { await worker.dispose() }
  }, 30000)

  it('starts one resident process and answers more than one request', async () => {
    const script = await writeWorker(ECHO_WORKER)
    const worker = new EmotionWorker({ pythonExecutable: 'python', scriptPath: script, readyTimeoutMs: 20000 })
    try {
      const handshake = await worker.start()
      expect(handshake.ready).toBe(true)
      expect(await worker.call('analyse', { audio_path: 'a.mp3' })).toEqual({ echo: { audio_path: 'a.mp3' } })
      expect(await worker.call('analyse', { audio_path: 'b.mp3' })).toEqual({ echo: { audio_path: 'b.mp3' } })
      expect(worker.alive).toBe(true)
    } finally { await worker.dispose() }
  }, 30000)

  it('surfaces a worker error with its code instead of hanging', async () => {
    const script = await writeWorker(ECHO_WORKER)
    const worker = new EmotionWorker({ pythonExecutable: 'python', scriptPath: script, readyTimeoutMs: 20000 })
    try {
      await worker.start()
      await expect(worker.call('boom', {})).rejects.toThrow(/ValueError: nope/)
      expect(worker.alive).toBe(true)
    } finally { await worker.dispose() }
  }, 30000)

  it('times out and kills a worker that never handshakes', async () => {
    const script = await writeWorker(DEAF_WORKER)
    const worker = new EmotionWorker({ pythonExecutable: 'python', scriptPath: script, readyTimeoutMs: 500 })
    await expect(worker.start()).rejects.toThrow(/handshake timeout/i)
    expect(worker.alive).toBe(false)
    await worker.dispose()
  }, 30000)

  it('uses the Python isolation flags and a scrubbed environment', async () => {
    const script = await writeWorker(ECHO_WORKER)
    const launches: { argv: string[]; env: NodeJS.ProcessEnv }[] = []
    const worker = new EmotionWorker({ pythonExecutable: 'python', scriptPath: script,
      readyTimeoutMs: 20000, onLaunch: (argv, env) => { launches.push({ argv, env }) } })
    try { await worker.start() } finally { await worker.dispose() }
    expect(launches[0]?.argv.slice(1, 5)).toEqual(['-I', '-B', '-X', 'utf8'])
    expect(launches[0]?.env.OPENAI_API_KEY).toBeUndefined()
    expect(launches[0]?.env.DEEPSEEK_API_KEY).toBeUndefined()
  }, 30000)
})

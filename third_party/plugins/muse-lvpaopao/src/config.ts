/** Deployment-only connection fields; no tool argument changes these values. */
import Schema from '@deepseek-ai/schemastery'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { BridgeError } from './port.ts'

/** Fixed trusted launcher and bounded process protocol. */
export interface Config {
  readonly transport: 'ssh' | 'local'
  readonly localPython: string
  readonly localHelper: string
  readonly sshExecutable: string
  readonly sshHostAlias: string
  readonly remotePython: string
  readonly remoteHelper: string
  readonly helperSha256: string
  readonly cwd: string
  readonly connectTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly cancelTimeoutMs: number
  readonly shutdownTimeoutMs: number
  readonly maxFrameBytes: number
  readonly maxPending: number
  readonly maxQueryChars: number
  readonly maxEpisodeCount: number
  readonly maxResultItems: number
  readonly downloadEnabled: boolean
  readonly outputDir: string
  readonly scpExecutable: string
  readonly copyTimeoutMs: number
  readonly copyPollIntervalMs: number
  readonly maxMediaBytes: number
  readonly downloadRequestTimeoutMs: number
}
/** Configuration is resolved before any process starts. */
export const Config: Schema<Config> = Schema.object({
  transport: Schema.union(['ssh', 'local']).default('ssh'),
  localPython: Schema.string().default(''), localHelper: Schema.string().default(''),
  sshExecutable: Schema.string().default('ssh'), sshHostAlias: Schema.string().default(''),
  remotePython: Schema.string().default(''), remoteHelper: Schema.string().default(''),
  helperSha256: Schema.string().required(), cwd: Schema.string().required(),
  connectTimeoutMs: Schema.number().step(1).min(1000).max(600000).default(30000),
  requestTimeoutMs: Schema.number().step(1).min(1000).max(600000).default(30000),
  cancelTimeoutMs: Schema.number().step(1).min(100).max(60000).default(5000),
  shutdownTimeoutMs: Schema.number().step(1).min(100).max(60000).default(10000),
  maxFrameBytes: Schema.number().step(1).min(1024).max(8388608).default(1048576),
  maxPending: Schema.number().step(1).min(1).max(64).default(8),
  maxQueryChars: Schema.number().step(1).min(1).max(80).default(80),
  maxEpisodeCount: Schema.number().step(1).min(1).max(20).default(20),
  maxResultItems: Schema.number().step(1).min(1).max(50).default(50),
  downloadEnabled: Schema.boolean().default(false), outputDir: Schema.string().default(''),
  scpExecutable: Schema.string().default('scp'),
  copyTimeoutMs: Schema.number().step(1).min(1000).max(1800000).default(180000),
  copyPollIntervalMs: Schema.number().step(1).min(50).max(5000).default(100),
  maxMediaBytes: Schema.number().step(1).min(1).max(2147483648).default(209715200),
  downloadRequestTimeoutMs: Schema.number().step(1).min(1000).max(1800000).default(600000),
})

/**
 * Reject invalid self-contained settings at activation, before spawning SSH.
 * @param config - Schema-resolved settings.
 * @returns The same validated immutable settings.
 */
export function validateConfig(config: Config): Config {
  if (config.transport === 'local') {
    for (const value of [config.localPython, config.localHelper]) {
      if (!isAbsolute(value) || /[\x00\r\n]/.test(value)) throw new Error('lvpaopao: local absolute paths required')
    }
  } else if (config.transport === 'ssh') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(config.sshHostAlias)) throw new Error('lvpaopao: invalid SSH alias')
    for (const value of [config.remotePython, config.remoteHelper]) {
      if (!/^[a-zA-Z]:[\\/]/.test(value) || /[\x00\r\n]/.test(value)) throw new Error('lvpaopao: Windows absolute paths required')
    }
  } else throw new Error('lvpaopao: invalid transport')
  if (!/^[0-9a-f]{64}$/.test(config.helperSha256)) throw new Error('lvpaopao: invalid helper digest')
  if (!config.sshExecutable.trim() || /[\x00\r\n]/.test(config.sshExecutable)) throw new Error('lvpaopao: invalid SSH executable')
  if (!isAbsolute(config.cwd) || /[\x00\r\n]/.test(config.cwd)) throw new Error('lvpaopao: invalid process directory')
  for (const [value, min, max] of [[config.connectTimeoutMs, 1000, 600000], [config.requestTimeoutMs, 1000, 600000],
    [config.cancelTimeoutMs, 100, 60000], [config.shutdownTimeoutMs, 100, 60000],
    [config.maxFrameBytes, 1024, 8388608], [config.maxPending, 1, 64],
    [config.maxQueryChars, 1, 80], [config.maxEpisodeCount, 1, 20], [config.maxResultItems, 1, 50],
    [config.copyTimeoutMs, 1000, 1800000], [config.copyPollIntervalMs, 50, 5000],
    [config.maxMediaBytes, 1, 2147483648], [config.downloadRequestTimeoutMs, 1000, 1800000]] as const) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('lvpaopao: invalid configured bound')
  }
  return Object.freeze({ ...config })
}

/**
 * Build a fixed PowerShell launch; only configuration enters this command.
 * @param config - Validated deployment fields.
 * @returns One SSH remote-command argument; requests travel through stdin only.
 */
export function remoteCommand(config: Config): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
  const script = `$ErrorActionPreference='Stop'; $env:PYTHONIOENCODING='utf-8'; `
    + `$p=${quote(config.remoteHelper)}; if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -ne ${quote(config.helperSha256)}) { throw 'helper-digest-mismatch' }; `
    + `& ${quote(config.remotePython)} -u $p --rpc-stdio; exit $LASTEXITCODE`
  return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Verify a fixed local helper before process creation without following a replaced link.
 * @param config - Validated local deployment fields.
 * @param signal - Host connection lifetime cancellation.
 */
export async function verifyLocalHelper(config: Config, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let file
  try {
    const before = await lstat(config.localHelper)
    if (!before.isFile() || before.isSymbolicLink() || before.size > 16777216) throw new BridgeError('helper-identity-mismatch')
    file = await open(config.localHelper, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await file.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) throw new BridgeError('helper-identity-mismatch')
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false, signal })) hash.update(chunk)
    const after = await file.stat(), current = await lstat(config.localHelper)
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino
      || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs || current.ctimeMs !== opened.ctimeMs
      || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs
      || hash.digest('hex') !== config.helperSha256) throw new BridgeError('helper-identity-mismatch')
    signal.throwIfAborted()
  } catch (error) {
    if (signal.aborted) throw new BridgeError('cancelled')
    if (error instanceof BridgeError) throw error
    throw new BridgeError('helper-identity-mismatch')
  } finally { await file?.close() }
}

/**
 * Select the UTF-8 JSONL protocol and the Host's two trusted media executables.
 * @param environment - Host environment; credential and unrelated DSH fields are never forwarded here.
 * @returns Explicit entries merged onto the subprocess provider's scrubbed base.
 */
export function localHelperEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    ...(environment.DSH_FFMPEG_PATH === undefined ? {} : { DSH_FFMPEG_PATH: environment.DSH_FFMPEG_PATH }),
    ...(environment.DSH_FFPROBE_PATH === undefined ? {} : { DSH_FFPROBE_PATH: environment.DSH_FFPROBE_PATH }) }
}

/** Deployment-only connection fields; no tool argument changes these values. */
import Schema from '@deepseek-ai/schemastery'
import { isAbsolute } from 'node:path'

/** Fixed trusted launcher and bounded process protocol. */
export interface Config {
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
  sshExecutable: Schema.string().default('ssh'), sshHostAlias: Schema.string().required(),
  remotePython: Schema.string().required(), remoteHelper: Schema.string().required(),
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
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(config.sshHostAlias)) throw new Error('lvpaopao: invalid SSH alias')
  for (const value of [config.remotePython, config.remoteHelper]) {
    if (!/^[a-zA-Z]:[\\/]/.test(value) || /[\x00\r\n]/.test(value)) throw new Error('lvpaopao: Windows absolute paths required')
  }
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

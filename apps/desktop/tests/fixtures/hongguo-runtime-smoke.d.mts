import type { SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Fixed native outcome facts; no process argument, response text or identity is retained. */
export interface HongguoNativeDiagnostic {
  kind: 'java' | 'python' | 'other'
  exitCode: number | null
  signal: SubprocessOutcome['signal']
  rejected: boolean
  markers: {
    bus: boolean; segmentation: boolean; fatalJvm: boolean; unicorn: boolean; nativeLink: boolean
    missingClass: boolean; outOfMemory: boolean; asciiInit: boolean; utf8Init: boolean
    asciiListener: boolean; utf8Listener: boolean; lossy: boolean; captureFailed: boolean
  }
}

/**
 * Observe real managed process completion using only bounded fixed classifications.
 * @param service Actual Cordis provider; all operations are delegated without replacement.
 * @returns Delegated operations, joined observations and at most eight safe records.
 */
export function createNativeDiagnostics(service: Pick<SubprocessRuntime, 'spawn' | 'resolveExecutable'>): {
  subprocess: Pick<SubprocessRuntime, 'spawn' | 'resolveExecutable'>
  settle(): Promise<void>
  records(): readonly HongguoNativeDiagnostic[]
}

/** Private executable and source paths used only by native payload fixtures. */
export interface HongguoSmokePaths {
  app: string
  java: string
  python: string
  ffmpeg: string
}

/** Existing client methods used by the local acceptance fixture. */
export interface HongguoSmokeClient {
  source: {
    load(signal: AbortSignal): Promise<unknown>
    sign(url: string, payload: { url: string; headers: Record<string, string> }, token: string,
      signal: AbortSignal): Promise<AsyncIterable<Buffer> & { statusCode: number; destroy(): void }>
  }
  signer: { ensure(signal: AbortSignal): Promise<{ url: string; token: string }> }
  dispose(): Promise<void>
}

/** Owned package client and subprocess resources whose disposal must complete before success. */
export interface HongguoSmokeRuntime {
  client: HongguoSmokeClient
  subprocess: Pick<SubprocessRuntime, 'spawn'>
  bridge: string
  disposeContext(): Promise<void>
  nativeDiagnostics?(): readonly HongguoNativeDiagnostic[]
}

/**
 * Check native bootstrap, original signing and offline module loading without platform requests.
 * @param root Packaged dsh directory.
 * @param resourcesRuntime Physical external runtime directory.
 * @param environment Prepared private runtime paths.
 * @param mount Runtime resource factory; defaults to the actual packaged client and provider.
 * @returns Booleans and native versions after joined cleanup.
 */
export function checkHongguoRuntime(root: string, resourcesRuntime: string, environment?: NodeJS.ProcessEnv,
  mount?: (root: string, paths: HongguoSmokePaths) => Promise<HongguoSmokeRuntime>): Promise<{
    java: string; python: string; bootstrap: true; signer: true; offline: true; aes: true; cleanup: true
  }>

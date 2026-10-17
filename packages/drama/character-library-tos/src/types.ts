/** Types used by the Volcengine TOS character-library provider. */
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Deployment configuration. Historical read prefixes are fixed by the provider. */
export interface CharacterLibraryTosOptions {
  /** Credential reference for the read-only identity's access key id. */
  readonly readAccessKeyIdRef?: string
  /** Credential reference for the read-only identity's secret access key. */
  readonly readSecretAccessKeyRef?: string
  /** Per-request connection timeout in milliseconds. @default 10000 */
  readonly connectionTimeoutMs?: number
  /** Per-request total timeout in milliseconds. @default 30000 */
  readonly requestTimeoutMs?: number
}

/** Validated provider settings captured at plugin load. */
export interface ResolvedConfig {
  readonly readCredentials: {
    readonly accessKeyIdRef: CredentialRef
    readonly secretAccessKeyRef: CredentialRef
  } | null
  readonly connectionTimeoutMs: number
  readonly requestTimeoutMs: number
}

/** Secret pair resolved for one operation and never retained by the store. */
export interface TosReadCredentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

/** Minimal Axios request configuration used only to add cancellation and request counting. */
export interface TosRequestConfig {
  readonly cancelToken?: object
  readonly [key: string]: unknown
}

/** Request interceptor surface exposed by TOS SDK 2.9.1. */
export interface TosRequestInterceptors {
  use(handler: (config: TosRequestConfig) => TosRequestConfig): number
  eject(id: number): void
}

/** Minimal TOS SDK client surface; it excludes every delete, copy, ACL and presign operation. */
export interface TosSdkClient {
  readonly axiosInst?: {
    readonly interceptors?: {
      readonly request?: TosRequestInterceptors
    }
  }
  listObjectsType2(input: Readonly<Record<string, unknown>>): Promise<unknown>
  headObject(input: Readonly<Record<string, unknown>>): Promise<unknown>
  getObjectV2(input: Readonly<Record<string, unknown>>): Promise<unknown>
}

/** Cancellation source exposed by TOS SDK 2.9.1. */
export interface TosCancelSource {
  readonly token: object
  cancel(reason?: string): void
}

/** Constructor surface required from TOS SDK 2.9.1. */
export interface TosClientConstructor {
  new(options: Readonly<Record<string, unknown>>): TosSdkClient
  readonly CancelToken?: {
    source(): TosCancelSource
  }
}

/** Validated SDK module projection. */
export interface TosSdkModule {
  readonly TosClient: TosClientConstructor
}

/** Injectable dependencies used by the Cordis provider and offline tests. */
export interface TosAdapterDependencies {
  readonly loadSdk: () => Promise<TosSdkModule>
  readonly resolveReadCredentials: () => Promise<TosReadCredentials | undefined>
}

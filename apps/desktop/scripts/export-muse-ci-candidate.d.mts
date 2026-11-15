/** Isolated CI inputs; production callers use the current checkout and process environment. */
export interface MuseCiCandidateExportOptions {
  readonly root?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}

/** Public ciphertext identity; the encryption key and signed upload URLs remain private. */
export interface MuseCiCandidateTransfer {
  readonly version: string
  readonly target: 'win-x64'
  readonly commit: string
  readonly runId: string
  readonly exportId: string
  readonly encryptedBytes: number
  readonly encryptedSha256: string
  readonly ivHex: string
  readonly authTagHex: string
}

/** Encrypt and export one completed Windows build and its bounded native acceptance evidence.
 * @param options - CI context and isolated test adapters.
 * @returns Transfer metadata after both private objects upload.
 */
export function exportMuseCiCandidate(options?: MuseCiCandidateExportOptions): Promise<MuseCiCandidateTransfer>

/** Completed target inputs used to record unsigned release files. */
export interface MuseUnsignedBuildOptions {
  readonly target: string
  readonly version: string
  readonly sourceCommit: string
  readonly artifactsRoot: string
}

/** Verified binary copied identically to each publication destination. */
export interface MuseMirrorArtifact {
  readonly path: string
  readonly filename: string
  readonly key: string
  readonly contentType: string
  readonly size: number
  readonly sha256: string
  readonly sha512: string
}

/** Mutable channel metadata promoted after every binary is public and verified. */
export interface MuseMirrorMetadata {
  readonly filename: string
  readonly key: string
  readonly contents: string
  readonly contentType: string
  readonly sha256: string
}

/** All three platform builds of one exact unsigned Muse release. */
export interface MuseMirrorPlan {
  readonly version: string
  readonly sourceCommit: string
  readonly artifacts: readonly MuseMirrorArtifact[]
  readonly metadata: readonly MuseMirrorMetadata[]
  readonly githubMetadata: readonly { readonly filename: string; readonly contents: string }[]
}

/**
 * Record hashes after the complete unsigned packaging checks have passed.
 * @param options - Exact completed build and artifact directory.
 * @returns Public build identity written beside the artifacts.
 */
export function recordMuseUnsignedBuild(options: MuseUnsignedBuildOptions): Promise<object>

/**
 * Validate all three platform builds before producing any upload operations.
 * @param options - Exact release and completed target directories.
 * @returns Immutable binaries and channel metadata ordered separately for publication.
 */
export function createMuseMirrorPlan(options: {
  readonly version: string
  readonly sourceCommit: string
  readonly artifactDirectories: Readonly<Record<string, string>>
  readonly legacyRcDiscovery?: boolean
}): Promise<MuseMirrorPlan>

/**
 * Locate the patched dependency installed for the source adapter workspace.
 * @returns Module read by the source PI-AI adapter after the locked pnpm install.
 */
export function sourcePiAiCompletionsModule(): string

/**
 * Locate the assembled application whose bytes will enter one unsigned release.
 * @param target Native Muse release target.
 * @param artifactsRoot Target-owned unsigned artifact directory.
 * @returns Actual assembled application ASAR path.
 */
export function packagedPiAiArchive(target: 'mac-arm64' | 'win-x64', artifactsRoot: string): string

/**
 * Compare the active ASAR module with the patched module used by source tests.
 * @param archive Actual assembled application ASAR, including its unpacked sibling when present.
 * @param sourceModule Installed source module; omission selects the adapter workspace dependency.
 * @returns Verified module identity; absent or different bytes throw.
 */
export function verifyPackagedPiAiPatch(archive: string, sourceModule?: string): Promise<{ module: string; sha256: string }>

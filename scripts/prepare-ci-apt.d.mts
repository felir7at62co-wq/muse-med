/** Type declarations for the standalone, dependency-free CI APT preparer. */

/**
 * Upgrade only official Ubuntu archive/security URLs while preserving other text.
 * @param source - APT source or mirror-list text.
 * @returns The updated text with its original line endings.
 */
export function upgradeUbuntuMirrorUrls(source: string): string

/**
 * Update existing source files and local mirror lists; unchanged files are not written.
 * @param directory - APT configuration directory.
 * @returns Changed filenames.
 */
export function prepareCiApt(directory: string): Promise<string[]>

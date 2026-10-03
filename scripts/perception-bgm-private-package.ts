/** Publication identity of the private, noncommercial music analysis provider. */
export const PRIVATE_MUSIC_ANALYSIS_DIRECTORY = 'packages/perception/perception-bgm'

const PRIVATE_MUSIC_ANALYSIS_NAME = '@deepseek-ai/dsh-perception-bgm'

/**
 * Identify the music analysis provider without exempting another DSH package.
 * @param directory - repository-relative package directory.
 * @param name - package name declared in its manifest.
 * @returns Whether both identifiers name the private music analysis provider.
 */
export function isPrivateMusicAnalysisPackage(directory: string, name: string | undefined): boolean {
  return directory === PRIVATE_MUSIC_ANALYSIS_DIRECTORY && name === PRIVATE_MUSIC_ANALYSIS_NAME
}

/** Directory and package identity for the desktop's private, file-only drama skill resources. */
const RESOURCE_DIRECTORY = 'packages/drama/skills'
const RESOURCE_NAME = '@deepseek-ai/dsh-drama-skills'

/**
 * Identify the file-only drama skill package without exempting another DSH package.
 * @param directory - repository-relative package directory.
 * @param name - package name declared in its manifest.
 * @returns whether both identifiers name the private drama skill resource package.
 */
export function isDramaSkillsResourcePackage(directory: string, name: string | undefined): boolean {
  return directory === RESOURCE_DIRECTORY && name === RESOURCE_NAME
}

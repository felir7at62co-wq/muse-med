/** Supplies maintained review guidance to the real skill and file-read tools. */
import { copyFileSync, cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'character-board-review-fixture'

export function apply() {
  const skills = join(process.cwd(), '.dsh', 'skills')
  cpSync(new URL('../../../packages/drama/skills/skills/tweet-drama-asset-vision-check', import.meta.url),
    join(skills, 'tweet-drama-asset-vision-check'), { recursive: true })
  mkdirSync(join(skills, 'anime-3d-assets'), { recursive: true })
  copyFileSync(new URL('../../../packages/drama/skills/skills/anime-3d-assets/SKILL.md', import.meta.url),
    join(skills, 'anime-3d-assets', 'SKILL.md'))
}

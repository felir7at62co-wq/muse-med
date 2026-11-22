/**
 * The choice both `episode_subtitles` and `jianying_draft` put to the user when Jingliu keeps legacy subtitle rows.
 *
 * Rows written before Jingliu recorded where a subtitle came from cannot be told apart from rows a user added by hand,
 * so neither tool replaces them on its own: keeping them sends the draft with those rows, remaking them archives and
 * replaces them with subtitles made from the shot's sound.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/**
 * Describe the keep-or-remake choice for some episodes of a Jingliu project.
 * @param project - Jingliu project ID.
 * @param episodes - Episodes whose shots keep legacy rows.
 * @returns The question to ask the user and the call for each answer.
 */
export function legacyChoice(project: string, episodes: readonly number[]): { [key: string]: Json } {
  const list = episodes.map(episode => `EP${String(episode)}`).join('、')
  return {
    question: `${list} 有镜流里来源不明的旧字幕（早先自动生成的或用户手加的，分不出来）。先问用户：保留旧字幕直接出草稿，还是把旧字幕存档后删掉、按声音重做？不要替用户选。`,
    keep: { tool: 'jianying_draft', args: { source: 'jingliu', project, episodes: [...episodes], keep_legacy_subtitles: true } },
    remake: { tool: 'episode_subtitles', args: { method: 'build', source: 'jingliu', project, episodes: [...episodes], replace_legacy: true } },
  }
}

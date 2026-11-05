/** Immutable display media for prebuilt market characters. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Immutable media revision, independent of a Skill package version. */
export type CharacterVersionId = Branded<'MuseCharacterVersionId'>

/** Equal-sized cells in a row-major sprite sheet; durations are positive milliseconds. */
export interface CharacterAnimation {
  readonly sheetUrl: string
  readonly columns: number
  readonly rows: number
  readonly cellWidth: number
  readonly cellHeight: number
  readonly idle: readonly { readonly cell: number; readonly durationMs: number }[]
  readonly introduce: readonly { readonly cell: number; readonly durationMs: number }[]
}

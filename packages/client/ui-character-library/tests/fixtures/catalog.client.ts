/** Synthetic browser fixtures only; these items are not catalog records or project characters. */
import type { LibraryBrowserSource, LibraryDisplayItem } from '../../src/client/types.ts'

/** Locally generated, labeled TEST portraits with no source material or remote image URLs. */
export const syntheticPreviewSources = Object.freeze({
  urban: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAACACAIAAAB7vvvtAAABZUlEQVR4nO3awWnDQBCGUVXiRtJQisoxlaUAN5BDAjkFAvpX9mp2iN7HnMwgLw9ksOztS7ttqw/QPUAhQCFAoWlAt93qd2YFKHTKLXb7afz1ozvP7B8NUAhQCFBoAdDfRnb2rzl2rkcCFGp3i1VecyRAIUAhQKEWH9K/90d2Rt5rVoBCHneEAIUAhQCFAIW2j/un2RlAgAABAtR4AAECBOjaQO+p6wJFmg5Ma4AO0axlWgD0sM4So2qgJ3XqjUqBpugUG9UBTdSpNALUA2i6TpkRoAZAJ+nUGAECBAgQIECAAAECBKgrkO9igFoa1RwbUBsgz6TrjCoP7HexfkB+WT2FadUh/bujPVDzAQQIEKD/AvTy+tZnAAECBAgQIECAAAECBAgQIECAAAECBAgQIEBNBhAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQLUZAABAgQI0AUGECBAgAA1HkCAAAEC1Hi+AZ2CXsUiUPezAAAAAElFTkSuQmCC',
  ancient: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAACACAIAAAB7vvvtAAAB5ElEQVR4nO3bQWrDQBBEUZ3EV8rW18idcrhAttk7kJVJzPRImq4q4//plRnk0QMZLNnbjYZt7g2kB1ARQEUAFS0DugzTr1kVQEUtl9jlt/nX9645s35vABUBVARQkQHofzNrxsec29eRACqKu8SUx5wJoCKAigAqiviQvl8/s2bmvVYFUBG3O4oAKgKoCKAigIq2z+8vZjAAAQQQQAAFD0AAAQTQawN9VL0uUEmTwOQB2kXjZTIAHdaxGKmBTurojaRAS3TERjqghTpKI4AygJbryIwACgBq0tEYAQQQQAABBBBAAAEEEECpQHwXAyjSSLNtgGKAuCetM1JumOdieUA8WW1hcm2SX3fEA4UPQM8D9PZ+vR/7frKA/ujkGAH0DEAPdUKMAIoHGugkGAGUDVTq2I0ACgaa1PEaAZQKtEvHaARQJNABHZcRQHlAh3UsRgCFAZ3U0RsBlAS0REdsBFAM0EIdpZEIaLmOzAigAKAmHY0RQG6gVh2BEUBWIIFOtxFAPiCZTqsRQCYgsU6fEUAOIItOkxFAciCjTocRQFogu85yI4CEQHaXDiOAVEB2kSYjgCRAdos+I4D6gewKrUZngezn320EUCeQ/cwFRv7/aoQPQAABBBBAwQMQQAABBFDw/ADCOhUeDXLjXwAAAABJRU5ErkJggg==',
  unknown: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAACACAIAAAB7vvvtAAABhklEQVR4nO3bQWrDMBRAQZ8kR+1per5eoYWuCgU/O1EkLeYtw8dRBmyIlBzfOu1YvYDdAxQBigBFw4Aep82fGRWg6C232OO366/fnXll/m6AIkARoGgB0P+uzJxf89q6nglQtN0tNvOaVwIUAYoARVs8pP/OX5m58l6jAhTZ7ogARYAiQBGg6PjSaYAiQBGgCFAEKAIUAYoARYCi9UCf1drlrQRKmh2Y1gDdolnLtADoaZ0lRrOBXtSZbzQVaIjOZKN5QAN1ZhoBiiYBDdeZZgQomgH0Jp05RoAiQBGgCFAEKAIUAYoARYAiQJHvYhGgyH5QBCiyJx051Yici0VOViNn85Ffd0TrgTYPUAQoAhQBikYCfezUqA8FKAIUAYoARYAiQBGgCFAEKAIUAYoARYAiQBGgCFAEKAIUAYoARYAiQBGgCFAEKAIUAYoARYAiQBGgCFAEKAIUAYoARYAiQBGgCFAEKAIUAYoARYAiQJH/i0WAIkARoAhQBCgCFAGKAEWAIkDRDxSNQLj1IY24AAAAAElFTkSuQmCC',
})

/** Synthetic display identities and metadata covering the browser's categories and review labels. */
export const syntheticLibraryItems: readonly LibraryDisplayItem[] = Object.freeze([
  {
    displayId: 'synthetic:urban-01',
    name: 'Test Urban A',
    category: 'urban',
    gender: 'male',
    style: 'realistic',
    tags: ['modern', 'studio'],
    appearanceTags: ['short hair', 'glasses'],
    sourceDescription: 'Synthetic browser fixture',
    description: 'Synthetic modern portrait for display tests.',
    approvalStatus: 'pending_review',
    metadataSummary: [{ label: 'Fixture version', value: 'test-1' }],
    thumbnailSrc: syntheticPreviewSources.urban,
    previewSrc: syntheticPreviewSources.urban,
  },
  {
    displayId: 'synthetic:ancient-01',
    name: 'Test Ancient B',
    category: 'ancient',
    gender: 'female',
    style: 'illustrated',
    tags: ['ancient', 'robe'],
    appearanceTags: ['long hair', 'robe'],
    sourceDescription: 'Synthetic browser fixture',
    description: 'Synthetic ancient portrait for display tests.',
    approvalStatus: 'approved',
    metadataSummary: [{ label: 'Fixture version', value: 'test-1' }],
    thumbnailSrc: syntheticPreviewSources.ancient,
    previewSrc: syntheticPreviewSources.ancient,
  },
  {
    displayId: 'synthetic:urban-02',
    name: 'Test Urban C',
    category: 'urban',
    gender: 'female',
    style: 'realistic',
    tags: ['modern', 'casual'],
    appearanceTags: ['long hair'],
    sourceDescription: 'Synthetic browser fixture',
    approvalStatus: 'rejected',
    metadataSummary: [],
    thumbnailSrc: syntheticPreviewSources.urban,
    previewSrc: syntheticPreviewSources.urban,
  },
  {
    displayId: 'synthetic:unknown-01',
    name: 'Test Unknown D',
    category: 'unknown',
    tags: [],
    appearanceTags: [],
    sourceDescription: 'Synthetic browser fixture',
    approvalStatus: 'unknown',
    metadataSummary: [],
    thumbnailSrc: syntheticPreviewSources.unknown,
    previewSrc: syntheticPreviewSources.unknown,
  },
])

/** Tests opt in to this source explicitly; every completed list identifies itself as fixture data. */
export const fixtureLibraryBrowserSource: LibraryBrowserSource = Object.freeze<LibraryBrowserSource>({
  async load({ signal }) {
    signal.throwIfAborted()
    return { kind: 'ready', items: syntheticLibraryItems, origin: 'fixture' }
  },
})

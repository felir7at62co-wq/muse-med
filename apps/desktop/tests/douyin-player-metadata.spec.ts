/** Public player properties must bind the visible source to one exact work. */
import { expect, it } from 'vitest'
import { Script } from 'node:vm'
import { JSDOM } from 'jsdom'
import { DOUYIN_PLAYER_PROBE } from '../src/douyin-policy.ts'

const target = '7624973984769004150'
const source = 'https://v3-web.douyinvod.com/fixture.mp4'
const work = (video: object = { playAddr: [source] }, awemeId: string | number = target) => ({ awemeId, video })

function fixture(properties: object, extra = '') {
  const dom = new JSDOM(`<main><section><video></video></section>${extra}</main>`, { url: `https://www.douyin.com/video/${target}` })
  const video = dom.window.document.querySelector('video')
  if (video === null || video.parentElement === null) throw new Error('Missing fixture player')
  Object.defineProperties(video, {
    paused: { value: false, configurable: true },
    readyState: { value: 2, configurable: true },
    currentSrc: { value: source, configurable: true },
  })
  Object.defineProperty(dom.window.document, 'readyState', { value: 'complete', configurable: true })
  Object.defineProperty(video.parentElement, '__reactProps$fixture', { value: properties, configurable: true })
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, bottom: 20, right: 20, width: 20, height: 20, toJSON: () => ({}),
  })
  const window: { _ROUTER_DATA?: object } = {}
  return { dom, video, window, run(): unknown {
    const result: unknown = new Script(DOUYIN_PLAYER_PROBE).runInNewContext({ document: dom.window.document, window, URL })
    return result
  } }
}

function metadataFixture(
  video: object = { playAddr: [source], duration: 2112208, width: 1920, height: 1320 }, awemeId: string | number = target,
) {
  const f = fixture({ children: { props: { awemeInfo: work(video, awemeId) } } })
  Object.defineProperties(f.video, {
    currentSrc: { value: 'blob:https://www.douyin.com/fixture', configurable: true },
    duration: { value: 2112.2, configurable: true },
    videoWidth: { value: 1920, configurable: true },
    videoHeight: { value: 1320, configurable: true },
  })
  return f
}

it('associates a loaded blob player with its nearest exact public work metadata', () => {
  const f = metadataFixture()
  try { expect(f.run()).toEqual({ id: target, src: source, association: 'player-metadata-verified',
    sourceField: 'video.playAddr', durationMs: 2112208, width: 1920, height: 1320,
    visible: { src: 'blob:https://www.douyin.com/fixture', duration: 2112.2, width: 1920, height: 1320 } }) }
  finally { f.dom.window.close() }
})

it.each([
  [{ playAddrH265: [{ src: source }] }, 'video.playAddrH265'],
  [{ bitRateList: [{ playAddr: { urlList: [source] } }] }, 'video.bitRateList.playAddr'],
  [{ playAddr: [`${source}?signature=fixture%2f~&part=1&part=2`] }, 'video.playAddr'],
] as const)('retains the exact plain address and its source field for a blob player %#', (address, sourceField) => {
  const f = metadataFixture({ ...address, duration: 2112208, width: 1920, height: 1320 })
  try {
    Object.defineProperty(f.video, 'paused', { value: true })
    expect(f.run()).toMatchObject({ association: 'player-metadata-verified', sourceField,
      src: sourceField === 'video.playAddr' ? `${source}?signature=fixture%2f~&part=1&part=2` : source })
    expect(f.video.paused).toBe(true)
  } finally { f.dom.window.close() }
})

it('deduplicates repeated objects and identical nearest work facts without reading an outer roster', () => {
  const video = { playAddr: [source], duration: 2112208, width: 1920, height: 1320 }
  const info = work(video)
  const f = metadataFixture()
  try {
    const parent = f.video.parentElement
    if (parent === null || parent.parentElement === null) throw new Error('Missing fixture ancestors')
    const props = { children: [{ props: { awemeInfo: info } }, { props: { awemeInfo: info } },
      { props: { awemeInfo: work({ ...video }) } }] }
    Object.defineProperty(parent, '__reactProps$fixture', { value: props })
    Object.defineProperty(parent.parentElement, '__reactProps$roster', { value: { awemeInfo: work(video, '7624973984769004151') } })
    expect(f.run()).toMatchObject({ id: target, association: 'player-metadata-verified' })
  } finally { f.dom.window.close() }
})

it.each(['id', 'duration', 'dimensions', 'address'])('rejects nearest conflicting work %s before consulting an outer matching work', (difference) => {
  const video = { playAddr: [source], duration: 2112208, width: 1920, height: 1320 }
  const other = { ...video, ...(difference === 'duration' ? { duration: 2112207 }
    : difference === 'dimensions' ? { width: 1919 }
      : difference === 'address' ? { playAddr: [`${source}?other=1`] } : {}) }
  const f = metadataFixture()
  try {
    const parent = f.video.parentElement
    if (parent === null || parent.parentElement === null) throw new Error('Missing fixture ancestors')
    Object.defineProperty(parent, '__reactProps$fixture', { value: { children: [{ awemeInfo: work(video) },
      { awemeInfo: work(other, difference === 'id' ? '7624973984769004151' : target) }] } })
    Object.defineProperty(parent.parentElement, '__reactProps$roster', { value: { awemeInfo: work(video) } })
    expect(f.run()).toBeNull()
  } finally { f.dom.window.close() }
})

it.each([
  { duration: 0 }, { duration: Number.NaN }, { duration: 86400001 }, { width: 0 }, { height: 1.5 },
  { width: 1200 }, { playAddr: ['http://v3.douyinvod.com/video.mp4'] },
  { playAddr: ['https://user:password@v3.douyinvod.com/video.mp4'] },
  { playAddr: ['https://v3.douyinvod.com/video.m3u8?mime_type=video_mp4'] },
  { playAddr: ['https://v3.douyinvod.com/video.mp4#fragment'] },
  { playAddr: ['https://evil.test/video.mp4'] }, { playAddr: ['blob:https://www.douyin.com/source'] },
])('rejects invalid public metadata or non-plain source %#', (invalid) => {
  const f = metadataFixture({ playAddr: [source], duration: 2112208, width: 1920, height: 1320, ...invalid })
  try { expect(f.run()).toEqual({ unsupported: 'BLOB_OR_SEGMENTS' }) }
  finally { f.dom.window.close() }
})

it.each(['duration', 'dimensions', 'foreign-blob', 'wrong-id', 'numeric-id', 'protected'])('rejects a blob player with %s', (difference) => {
  const f = metadataFixture(undefined, difference === 'wrong-id' ? '7624973984769004151'
    : difference === 'numeric-id' ? Number(target) : target)
  try {
    if (difference === 'duration') Object.defineProperty(f.video, 'duration', { value: 2112.5 })
    if (difference === 'dimensions') Object.defineProperty(f.video, 'videoHeight', { value: 1000 })
    if (difference === 'foreign-blob') Object.defineProperty(f.video, 'currentSrc', { value: 'blob:https://evil.test/fixture' })
    if (difference === 'protected') Object.defineProperty(f.video, 'mediaKeys', { value: {} })
    expect(f.run()).toEqual({ unsupported: difference === 'protected' ? 'PROTECTED_MEDIA' : 'BLOB_OR_SEGMENTS' })
  } finally { f.dom.window.close() }
})

it('rejects active protection metadata even when a blob player otherwise matches', () => {
  const f = metadataFixture({ playAddr: { urlList: [source], encryptionKey: 'protected' },
    duration: 2112208, width: 1920, height: 1320 })
  try { expect(f.run()).toEqual({ unsupported: 'PROTECTED_MEDIA' }) }
  finally { f.dom.window.close() }
})

it('rejects a mismatched work marker before using duration-based player metadata', () => {
  const f = metadataFixture()
  try {
    Object.defineProperty(f.video, 'currentSrc', { value: `${source}?__vid=7624973984769004151` })
    expect(f.run()).toEqual({ unsupported: 'PAGE_METADATA' })
  } finally { f.dom.window.close() }
})

it('binds one visible player to its own work properties when the legacy bootstrap is absent', () => {
  const f = fixture({ children: [{ props: { awemeInfo: { ...work(), authorInfo: { token: 'PRIVATE' } } } }] })
  try {
    expect(f.run()).toEqual({ id: target, src: source })
    expect(JSON.stringify(f.run())).not.toContain('PRIVATE')
  } finally { f.dom.window.close() }
})

it('keeps a loaded paused player eligible without starting or changing playback', () => {
  const f = fixture({ children: { props: { awemeInfo: work() } } })
  try {
    Object.defineProperty(f.video, 'paused', { value: true })
    expect(f.run()).toEqual({ id: target, src: source })
    expect(f.video.paused).toBe(true)
  } finally { f.dom.window.close() }
})

it('waits for media data before using a visible player address', () => {
  const f = fixture({ children: { props: { awemeInfo: work() } } })
  try {
    Object.defineProperty(f.video, 'readyState', { value: 1 })
    expect(f.run()).toBeNull()
  } finally { f.dom.window.close() }
})

it.each([
  { playAddr: [{ src: source }] },
  { playAddrH265: [source] },
  { playAddrH265: [{ src: source }] },
  { bitRateList: [{ playAddr: [source] }] },
  { bitRateList: [{ playAddr: [{ src: source }] }] },
  { bitRateList: [{ playAddr: { urlList: [source] } }] },
])('accepts the unchanged exact player address in public bitrate metadata %#', (video) => {
  const f = fixture({ children: { props: { awemeInfo: work(video) } } })
  try { expect(f.run()).toEqual({ id: target, src: source }) }
  finally { f.dom.window.close() }
})

it.each([
  { children: { props: { awemeInfo: work({ playAddr: ['https://v3-web.douyinvod.com/other.mp4'] }) } } },
  { children: { props: { awemeInfo: work({ playAddr: [{ src: 'https://v3-web.douyinvod.com/other.mp4' }] }) } } },
  { children: { props: { awemeInfo: work({ playAddr: [{ url: source }] }) } } },
  { children: { props: { authorInfo: work() } } },
  { children: { props: { awemeInfo: work(undefined, Number(target)) } } },
])('refuses unrelated addresses, unassociated fields and rounded numeric identifiers %#', (properties) => {
  const f = fixture(properties)
  try { expect(f.run()).toEqual({ unsupported: 'PAGE_METADATA' }) }
  finally { f.dom.window.close() }
})

it('refuses two work identities claiming the same visible player address', () => {
  const f = fixture({ children: [{ props: { awemeInfo: work() } },
    { props: { awemeInfo: work(undefined, '7624973984769004151') } }] })
  try { expect(f.run()).toBeNull() }
  finally { f.dom.window.close() }
})

it.each([
  { playAddr: [source], encryptionKey: 'protected' },
  { playAddr: [source], meta: { drm: true } },
  { bitRateList: [{ playAddr: [source], license: 'protected' }] },
  { playAddr: [{ src: source, drm: true }] },
])('refuses protection markers before granting a native transfer %#', (video) => {
  const f = fixture({ children: { props: { awemeInfo: work(video) } } })
  try { expect(f.run()).toEqual({ unsupported: 'PROTECTED_MEDIA' }) }
  finally { f.dom.window.close() }
})

it('keeps inactive protection flags distinct from active protection', () => {
  const f = fixture({ children: { props: { awemeInfo: work({ playAddr: [source], encrypt: false, meta: { drm: 0 } }) } } })
  try { expect(f.run()).toEqual({ id: target, src: source }) }
  finally { f.dom.window.close() }
})

it('refuses protected players, blob sources and multiple visible players', () => {
  for (const mode of ['protected', 'blob', 'multiple']) {
    const f = fixture({ children: { props: { awemeInfo: work() } } }, mode === 'multiple' ? '<video></video>' : '')
    try {
      if (mode === 'protected') Object.defineProperty(f.video, 'mediaKeys', { value: {} })
      if (mode === 'blob') Object.defineProperty(f.video, 'currentSrc', { value: 'blob:https://www.douyin.com/fixture' })
      expect(f.run()).toEqual(mode === 'multiple' ? null
        : { unsupported: mode === 'protected' ? 'PROTECTED_MEDIA' : 'BLOB_OR_SEGMENTS' })
    } finally { f.dom.window.close() }
  }
})

it('retains ambiguity rejection when the legacy bootstrap is present', () => {
  const f = fixture({ children: { props: { awemeInfo: work() } } })
  f.window._ROUTER_DATA = { loaderData: { video: { videoInfoRes: { item_list: [work(), work()] } } } }
  try { expect(f.run()).toBeNull() }
  finally { f.dom.window.close() }
})

it('binds the normal player work marker while preserving the unchanged native source', () => {
  const supplied = `${source}?signature=fixture&quality=hd`
  const current = `${supplied}&__vid=${target}`
  const f = fixture({ children: { props: { awemeInfo: work({ playAddr: [{ src: supplied }] }) } } })
  try {
    Object.defineProperty(f.video, 'currentSrc', { value: current })
    expect(f.run()).toEqual({ id: target, src: current })
  } finally { f.dom.window.close() }
})

it.each(['name=hello%20world', 'signature=abc~def', 'signature=a%2fb'])('preserves encoded query values when matching the player work marker: %s', (query) => {
  const supplied = `${source}?${query}&part=1&part=2`
  const current = `${supplied}&__vid=${target}`
  const f = fixture({ children: { props: { awemeInfo: work({ playAddr: [{ src: supplied }] }) } } })
  try {
    Object.defineProperty(f.video, 'currentSrc', { value: current })
    expect(f.run()).toEqual({ id: target, src: current })
  } finally { f.dom.window.close() }
})

it.each([
  `${source}?part=2&part=1&signature=fixture&__vid=${target}`,
  `${source}?part=1&part=2&signature=changed&__vid=${target}`,
  `${source}?part=1&signature=fixture&__vid=${target}`,
  `${source}?part=1&part=2&signature=fixture&__vid=${target}#changed`,
  `https://user@v3-web.douyinvod.com/fixture.mp4?part=1&part=2&signature=fixture&__vid=${target}`,
])('refuses changed query ordering, duplicates and base URL fields: %s', (current) => {
  const supplied = `${source}?part=1&part=2&signature=fixture`
  const f = fixture({ children: { props: { awemeInfo: work({ playAddr: [{ src: supplied }] }) } } })
  try {
    Object.defineProperty(f.video, 'currentSrc', { value: current })
    expect(f.run()).toEqual({ unsupported: 'PAGE_METADATA' })
  } finally { f.dom.window.close() }
})

it.each([
  `?signature=changed&__vid=${target}`,
  '?signature=fixture&__vid=7624973984769004151',
  `?signature=fixture&__vid=${target}&__vid=${target}`,
  `?signature=fixture&__vid=${target}&extra=unsupported`,
  '?signature=fixture',
])('refuses modified signed fields, unrelated work markers and additional parameters %#', (query) => {
  const supplied = `${source}?signature=fixture`
  const current = query === '?signature=fixture' ? `${source}/other.mp4${query}` : `${source}${query}`
  const f = fixture({ children: { props: { awemeInfo: work({ playAddr: [{ src: supplied }] }) } } })
  try {
    Object.defineProperty(f.video, 'currentSrc', { value: current })
    expect(f.run()).toEqual({ unsupported: 'PAGE_METADATA' })
  } finally { f.dom.window.close() }
})

it('rejects a contradictory work marker even when the metadata contains that exact address', () => {
  const current = `${source}?__vid=7624973984769004151`
  const f = fixture({ children: { props: { awemeInfo: work({ playAddr: [{ src: current }] }) } } })
  try {
    Object.defineProperty(f.video, 'currentSrc', { value: current })
    expect(f.run()).toEqual({ unsupported: 'PAGE_METADATA' })
  } finally { f.dom.window.close() }
})

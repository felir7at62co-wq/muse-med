/** Pinned community source copies retain upstream text; Muse-owned plugins remain maintained. */
import sources from '../third_party/plugins/sources.json' with { type: 'json' }

/** Exact directory prefixes declared by the community source inventory. */
export const retainedPluginSourcePrefixes = Object.keys(sources).map(name => `third_party/plugins/${name}/`)

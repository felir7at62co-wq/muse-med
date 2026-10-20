/** Project aliases and current voice references supplement, rather than replace, live asset identities. */
import { z } from 'zod'
import { productionName, requirementKey } from './production-plan.ts'
import type { ProductionAsset, ProductionRequirement } from './production-types.ts'

const aliases = z.union([z.string().transform(value => value.split(/[、，,;；|]/u)), z.array(z.string())]).optional()
const registrationSchema = z.object({ jubian_asset_id: z.coerce.number().int().positive(), url: z.string().optional(),
  name: z.string().optional(), character_name: z.string().optional(), character_id: z.string().optional(),
  aliases, state_or_costume: z.string().optional(), scene_conditions: z.array(z.string()).optional() })
const voiceSchema = z.object({ reference_audio_asset_id: z.number().int().positive(), reference_audio: z.string(),
  reference_audio_sha256: z.string().regex(/^[a-f0-9]{64}$/u), reference_audio_duration_seconds: z.number().positive(),
  voice_period_id: z.string().optional() })
const characterSchema = z.object({ character_id: z.string(), name: z.string(), aliases,
  voice_profile: z.unknown().optional(), voice_profiles: z.array(z.unknown()).optional() })

/** Merge attributable local labels and measured voice-reference metadata into the live inventory.
 * @param inventory - Asset IDs and current URLs read from this remote project.
 * @param manifest - Optional local image-registration document.
 * @param project - Project configuration containing current adopted voice references.
 * @param requirements - Source-derived per-shot requirements, including any explicit Muse overrides.
 * @returns Enriched candidates and voice identity requirements; no remote or local mutation.
 */
export function productionMetadata(inventory: ProductionAsset[], manifest: unknown, project: unknown,
  requirements: ProductionRequirement[]): { assets: ProductionAsset[]; requirements: ProductionRequirement[] } {
  const assets = structuredClone(inventory)
  const document = z.object({ items: z.array(z.unknown()).optional(), assets: z.array(z.unknown()).optional() }).safeParse(manifest)
  for (const value of document.success ? document.data.items ?? document.data.assets ?? [] : []) {
    const parsed = registrationSchema.safeParse(value)
    if (!parsed.success) continue
    const item = parsed.data, asset = assets.find(row => row.asset_id === item.jubian_asset_id)
    if (!asset || !item.url || item.url !== asset.url) continue
    asset.aliases = [...(item.aliases ?? []), ...(item.character_name ? [item.character_name] : []), ...(item.name ? [item.name] : [])]
    if (item.character_id) asset.character_id = item.character_id
    if (item.state_or_costume) asset.state_or_costume = item.state_or_costume
    if (item.scene_conditions) asset.scene_conditions = item.scene_conditions
  }
  const config = z.object({ project_bible: z.object({ characters: z.array(z.unknown()) }).optional() }).safeParse(project)
  const characters = (config.success ? config.data.project_bible?.characters ?? [] : [])
    .flatMap((value) => { const parsed = characterSchema.safeParse(value); return parsed.success ? [parsed.data] : [] })
  for (const character of characters) for (const value of character.voice_profiles
    ?? (character.voice_profile ? [character.voice_profile] : [])) {
    const parsed = voiceSchema.safeParse(value)
    if (!parsed.success) continue
    const profile = parsed.data
    const asset = assets.find(row => row.kind === 'voice' && row.asset_id === profile.reference_audio_asset_id
      && row.url === profile.reference_audio && (!row.character_id || row.character_id === character.character_id)
      && (!row.voice_period_id || row.voice_period_id === profile.voice_period_id))
    if (!asset) continue
    asset.character_id = character.character_id
    if (profile.voice_period_id) asset.voice_period_id = profile.voice_period_id
    asset.aliases = [character.name, ...(character.aliases ?? [])]
    asset.duration_seconds = profile.reference_audio_duration_seconds
    asset.audio_duration_basis = 'project_reference_metadata'
  }
  return { assets, requirements: requirements.map((req) => {
    if (req.kind !== 'voice') return req
    const named = characters.filter(row => [row.name, ...(row.aliases ?? [])]
      .some(name => productionName(name) === productionName(req.name)))
    const character = named[0]
    if (named.length !== 1 || character === undefined) return req
    const profiles = (character.voice_profiles ?? []).map(value =>
      z.object({ voice_period_id: z.string().optional() }).safeParse(value))
    const first = profiles[0]
    const period = profiles.length === 1 && first?.success ? first.data.voice_period_id : undefined
    return { ...req, character_id: req.character_id ?? character.character_id,
      ...(req.voice_period_id || !period ? {} : { voice_period_id: period }) }
  }).filter((req, index, list) => list.findIndex(other => requirementKey(other) === requirementKey(req)) === index) }
}

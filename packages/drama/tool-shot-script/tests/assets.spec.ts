import { describe, expect, it } from 'vitest'
import { bindShot, parseAssetManifest } from '../src/assets.ts'
import { parseShotScript } from '../src/script.ts'
import type { BoundAsset, ParsedShot } from '../src/types.ts'
import { actionShot, assetRow, scriptOf, speakingShot } from './harness.ts'

/** Parse one script and return its first shot. */
function firstShot(text: string): ParsedShot {
  const shot = parseShotScript(text, { actionShotSeconds: 2 }).shots[0]
  if (shot === undefined) throw new Error('fixture produced no shot')
  return shot
}

/** The names of every bound asset, in binding order. */
function names(assets: readonly BoundAsset[]): string[] {
  return assets.map(asset => asset.name)
}

describe('reading the asset manifest', () => {
  it('normalizes every declared field, including the older key spellings', () => {
    const rows = parseAssetManifest({
      assets: [
        assetRow('苏晚', '角色'),
        { name: '后厨', type: '场景', asset_id: 70002, material_id: '80002', image_url: 'https://cdn/x.png' },
      ],
    }, 'manifest.json').assets
    expect(rows[0]).toEqual({
      name: '苏晚',
      id: 'id-苏晚',
      type: '角色',
      official: true,
      assetId: '70001',
      materialId: '80001',
      url: 'https://cdn.example.test/asset.png',
      localPath: '',
      aliases: '',
      episodes: { kind: 'list', numbers: [1] },
      stateOrCostume: '非孕期；青年；家常装',
    })
    expect(rows[1]).toEqual({
      name: '后厨',
      id: '后厨',
      type: '场景',
      official: false,
      assetId: '70002',
      materialId: '80002',
      url: 'https://cdn/x.png',
      localPath: '',
      aliases: '',
      episodes: { kind: 'missing' },
      stateOrCostume: '',
    })
  })

  it('reads the project manifest that spells its asset array items', () => {
    const rows = parseAssetManifest({
      script_id: 2708,
      items: [assetRow('苏晚', '角色', { episodes: ['all'], state_or_costume: '孕早期（孕八周）、孕期职场装' })],
    }, 'manifest.json').assets
    expect(rows).toHaveLength(1)
    expect(rows[0]?.episodes).toEqual({ kind: 'all' })
    expect(rows[0]?.stateOrCostume).toBe('孕早期（孕八周）、孕期职场装')
  })

  it('refuses a document that is not an object with an assets array', () => {
    expect(() => parseAssetManifest([], 'manifest.json')).toThrow('资产清单必须是 JSON 对象')
    expect(() => parseAssetManifest(null, 'manifest.json')).toThrow('资产清单必须是 JSON 对象')
    expect(() => parseAssetManifest({}, 'manifest.json').assets).toThrow('缺少 assets 数组')
  })

  it('refuses a malformed row', () => {
    expect(() => parseAssetManifest({ assets: ['x'] }, 'manifest.json').assets).toThrow('assets[0] 不是对象')
    expect(() => parseAssetManifest({ assets: [{ type: '角色' }] }, 'manifest.json').assets).toThrow('缺少 name')
    expect(() => parseAssetManifest({ assets: [{ name: '苏晚' }] }, 'manifest.json').assets).toThrow('缺少 type')
  })

  it('reports a type the binder cannot match, naming the row, the name, the allowed set and the repair', () => {
    // `role` is not a spelling this binder matches. Keeping it without a word
    // dropped the character while the shot bound only its scene, and `validate`
    // answered `ok: true, 0 failures`. Refusing the whole read was the other
    // extreme: the caller then saw none of the manifest's other findings.
    const read = parseAssetManifest({
      assets: [assetRow('苏晚', '角色'), assetRow('林晚', 'role'), assetRow('后厨', '场景')],
    }, 'manifest.json')

    expect(read.issues).toHaveLength(1)
    const issue = read.issues[0]
    expect(issue?.severity).toBe('failure')
    expect(issue?.code).toBe('asset_type_unusable')
    expect(issue?.message).toContain('manifest.json: 第 2 条资产（林晚）的 type="role"')
    expect(issue?.message).toContain('只接受 角色、character、场景、scene、道具、prop')
    expect(issue?.message).toContain('ok:true')
    // The readable rows are still read: the report keeps every other finding.
    expect(read.assets.map(row => row.name)).toEqual(['苏晚', '林晚', '后厨'])
  })

  it('accepts a manifest whose every type the binder matches, reporting nothing', () => {
    const read = parseAssetManifest({
      assets: [assetRow('苏晚', '角色'), assetRow('林晚', 'character'), assetRow('后厨', '场景'),
        assetRow('客厅', 'scene'), assetRow('奶瓶', '道具'), assetRow('公文箱', 'prop')],
    }, 'manifest.json')
    expect(read.assets.map(row => row.type)).toEqual(['角色', 'character', '场景', 'scene', '道具', 'prop'])
    expect(read.issues).toEqual([])
  })
})

describe('binding one shot', () => {
  const speaking = firstShot(scriptOf(speakingShot(1, '苏晚：原文台词', ['出镜人物：苏晚', '核心场景：后厨', '关键道具：奶瓶'])))

  it('binds characters, scene, and props in prompt order', () => {
    const binding = bindShot(speaking, parseAssetManifest({
      assets: [assetRow('苏晚', '角色'), assetRow('后厨', '场景'), assetRow('奶瓶', '道具')],
    }, 'manifest.json').assets)
    expect(binding.issues).toEqual([])
    expect(names(binding.assets)).toEqual(['苏晚', '后厨', '奶瓶'])
    expect(binding.characters).toEqual(['苏晚'])
    expect(binding.scene).toBe('后厨')
    expect(binding.props).toEqual(['奶瓶'])
  })

  it('binds a character and a prop named only in the prompt text', () => {
    const binding = bindShot(speaking, parseAssetManifest({
      assets: [assetRow('苏晚', 'character'), assetRow('奶瓶', 'prop'), assetRow('后厨', 'scene')],
    }, 'manifest.json').assets)
    expect(names(binding.assets)).toEqual(['苏晚', '后厨', '奶瓶'])
  })

  it('reads the scene out of the prompt text when the field is omitted', () => {
    const shot = firstShot(scriptOf(speakingShot(1, '苏晚：原文台词')))
    const binding = bindShot(shot, parseAssetManifest({
      assets: [assetRow('场景图视角后厨', '场景'), assetRow('后厨', '场景')],
    }, 'manifest.json').assets)
    expect(binding.scene).toBe('场景图视角后厨')
  })

  it('warns when no scene asset is bound', () => {
    const shot = firstShot(scriptOf(speakingShot(1, '苏晚：原文台词')))
    const binding = bindShot(shot, parseAssetManifest({ assets: [assetRow('苏晚', '角色')] }, 'manifest.json').assets)
    expect(binding.issues.map(issue => issue.code)).toEqual(['no_scene_bound'])
    expect(binding.issues[0]?.severity).toBe('warning')
  })

  it('refuses a scene name that the manifest does not carry', () => {
    const binding = bindShot(speaking, parseAssetManifest({
      assets: [assetRow('苏晚', '角色'), assetRow('奶瓶', '道具')],
    }, 'manifest.json').assets)
    expect(binding.issues.map(issue => issue.code)).toEqual(['unregistered_scene'])
    expect(binding.issues[0]?.message).toContain('后厨')
    expect(binding.scene).toBe('后厨')
  })

  it('refuses an asset that did not pass the official gate', () => {
    const binding = bindShot(speaking, parseAssetManifest({
      assets: [assetRow('苏晚', '角色', { official: false }), assetRow('后厨', '场景'), assetRow('奶瓶', '道具')],
    }, 'manifest.json').assets)
    expect(binding.issues.map(issue => issue.code)).toEqual(['unconfirmed_asset'])
    expect(binding.issues[0]?.message).toContain('official 不是 true')
  })

  it('refuses an official asset without a Jubian id or URL, naming every missing field', () => {
    const missing = bindShot(speaking, parseAssetManifest({
      assets: [
        assetRow('苏晚', '角色', { jubian_asset_id: '', jubian_material_id: '', url: '' }),
        assetRow('后厨', '场景'),
        assetRow('奶瓶', '道具'),
      ],
    }, 'manifest.json').assets)
    expect(missing.issues.map(issue => issue.code)).toEqual(['incomplete_asset'])
    expect(missing.issues[0]?.message).toContain('jubian_asset_id、jubian_material_id、URL')

    const partial = bindShot(speaking, parseAssetManifest({
      assets: [assetRow('苏晚', '角色', { jubian_material_id: '' }), assetRow('后厨', '场景'), assetRow('奶瓶', '道具')],
    }, 'manifest.json').assets)
    expect(partial.issues[0]?.message).toContain('jubian_material_id')
  })

  it('binds a name once even when the manifest declares it twice', () => {
    const binding = bindShot(speaking, parseAssetManifest({
      assets: [assetRow('苏晚', '角色'), assetRow('苏晚', '角色'), assetRow('后厨', '场景'), assetRow('奶瓶', '道具')],
    }, 'manifest.json').assets)
    expect(names(binding.assets)).toEqual(['苏晚', '后厨', '奶瓶'])
  })

  it('treats 关键道具：无 as no prop binding and ignores other types', () => {
    const shot = firstShot(scriptOf(actionShot(1, ['核心场景：后厨', '关键道具：无'])))
    const binding = bindShot(shot, parseAssetManifest({
      assets: [assetRow('苏晚', '角色'), assetRow('后厨', '场景'), assetRow('奶瓶', '道具')],
    }, 'manifest.json').assets)
    expect(binding.props).toEqual([])
    expect(names(binding.assets)).toEqual(['苏晚', '后厨'])
  })
})

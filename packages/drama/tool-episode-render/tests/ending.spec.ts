/** Tail-frame extraction, its proof against a sequential decode, and the ending clip. */

import { copyFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ENDING_AUDIO_ASSET, ENDING_EFFECT_ASSET, ENDING_SECONDS } from '../src/delivery.ts'
import {
  buildEndingClip,
  extractTailFrame,
  lastFrameIndex,
  parseFramemd5,
  requireEndingAssetFile,
  requireEndingEffectFits,
  requireShippedEndingAsset,
  TAIL_SEEK_SECONDS,
} from '../src/ending.ts'
import { createMediaToolkit } from '../src/ffmpeg.ts'
import {
  cleanup,
  framemd5Line,
  probeHandler,
  shippedEndingAsset,
  sizeOf,
  stubChannel,
  tempProject,
  writePlaceholder,
  type ChannelCall,
} from './harness.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (dir) => { await cleanup(dir) }))
})

/** The input path of an `-i` argument. */
function inputOf(call: ChannelCall): string {
  return call.args[call.args.indexOf('-i') + 1] ?? ''
}

/** Whether one call re-extracts a frame by index instead of seeking. */
function isSelect(call: ChannelCall): boolean {
  return call.command === 'ffmpeg' && call.args.some(argument => argument.startsWith('select=eq(n'))
}

/**
 * Build the channel a tail-frame extraction talks to.
 * @param options - Whether the seek writes a file, and the hashes each decode answers with.
 * @returns The stub channel.
 */
function tailChannel(options: {
  seekWrites: boolean
  imageHashes: readonly string[]
  videoHashes: readonly string[]
  imageCode?: number
  videoCode?: number
}): ReturnType<typeof stubChannel> {
  const queued = [...options.imageHashes]
  return stubChannel([
    (call) => {
      if (call.args.includes('-sseof')) {
        if (!options.seekWrites) return {}
        return { after: async () => { await writePlaceholder(call.args[call.args.length - 1] ?? '', 'png') } }
      }
      if (!call.args.includes('framemd5')) return undefined
      const input = inputOf(call)
      if (input.endsWith('.png')) {
        if (options.imageCode !== undefined && options.imageCode !== 0) {
          return { code: options.imageCode, stderr: 'Invalid PNG' }
        }
        const hash = queued.shift()
        return { stdout: hash === undefined ? '' : `${framemd5Line(0, hash)}\n` }
      }
      if (options.videoCode !== undefined && options.videoCode !== 0) {
        return { code: options.videoCode, stderr: 'Invalid data' }
      }
      return { stdout: `${options.videoHashes.map((hash, index) => framemd5Line(index, hash)).join('\n')}\n` }
    },
    (call) => {
      if (!isSelect(call)) return undefined
      return { after: async () => { await writePlaceholder(call.args[call.args.length - 1] ?? '', 'png') } }
    },
  ])
}

describe('parseFramemd5', () => {
  it('reads one hash per frame line and skips the stream header', () => {
    const report = [
      '#format: lavfi, rgb24, 1440x2560',
      '#stream#, dts, pts, duration, size, hash',
      framemd5Line(0, 'aaa'),
      framemd5Line(1, 'bbb'),
      '',
    ].join('\n')
    expect(parseFramemd5(report)).toEqual(['aaa', 'bbb'])
  })

  it('ignores a line that is not a frame row', () => {
    expect(parseFramemd5('nonsense\n0, 0, 0, 1, 2, \n')).toEqual([])
  })

  it('ignores a frame row whose hash field is empty', () => {
    expect(parseFramemd5('0, 0, 0, 1, 2, \n')).toEqual([])
  })
})

describe('lastFrameIndex', () => {
  it('is the zero-based index of the final frame', () => {
    expect(lastFrameIndex(841)).toBe(840)
  })
})

describe('extractTailFrame', () => {
  it('accepts the seeked frame when it equals the sequential decode tail', async () => {
    const project = await tempProject()
    temporary.push(project)
    const channel = tailChannel({ seekWrites: true, imageHashes: ['tail'], videoHashes: ['a', 'b', 'tail'] })
    const evidence = await extractTailFrame(
      createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
      'C:/proj/video/02/shot_006.mp4',
      join(project, 'tail.png'),
    )
    expect(evidence).toEqual({
      path: join(project, 'tail.png'),
      frameMd5: 'tail',
      sequentialTailMd5: 'tail',
      fromSequentialDecode: false,
      matchesSequentialTail: true,
    })
    expect(channel.calls[0]?.args).toContain(TAIL_SEEK_SECONDS)
    expect(await sizeOf(evidence.path)).toBe(3)
  })

  it('re-extracts by index when the seeked frame is not the tail, and proves the replacement', async () => {
    const project = await tempProject()
    temporary.push(project)
    const channel = tailChannel({ seekWrites: true, imageHashes: ['wrong', 'tail'], videoHashes: ['a', 'tail'] })
    const evidence = await extractTailFrame(
      createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
      'C:/proj/video/02/shot_006.mp4',
      join(project, 'tail.png'),
    )
    expect(evidence.fromSequentialDecode).toBe(true)
    expect(evidence.matchesSequentialTail).toBe(true)
    expect(evidence.frameMd5).toBe('tail')
    const select = channel.calls.find(isSelect)
    expect(select?.args).toContain('select=eq(n\\,1)')
  })

  it('stops instead of freezing an unproved frame', async () => {
    const project = await tempProject()
    temporary.push(project)
    const channel = tailChannel({ seekWrites: true, imageHashes: ['wrong', 'still-wrong'], videoHashes: ['a', 'tail'] })
    await expect(extractTailFrame(
      createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
      'C:/proj/video/02/shot_006.mp4',
      join(project, 'tail.png'),
    )).rejects.toThrow('尾帧校验不通过')
  })

  it('refuses a wrong sequential replacement when the seek produced no frame', async () => {
    const project = await tempProject()
    temporary.push(project)
    const channel = tailChannel({ seekWrites: false, imageHashes: ['wrong'], videoHashes: ['tail'] })
    await expect(extractTailFrame(
      createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
      join(project, 'source.mp4'), join(project, 'tail.png'),
    )).rejects.toThrow('顺序抽出的帧 wrong 与最后一帧 tail')
    expect(channel.calls.some(isSelect)).toBe(true)
  })

  it('falls back to the proven sequential tail when `-sseof` writes no file', async () => {
    const project = await tempProject()
    temporary.push(project)
    const channel = tailChannel({ seekWrites: false, imageHashes: ['tail'], videoHashes: ['a', 'tail'] })
    const evidence = await extractTailFrame(
      createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
      'C:/proj/video/02/shot_006.mp4',
      join(project, 'tail.png'),
    )
    expect(evidence.fromSequentialDecode).toBe(true)
    expect(evidence.matchesSequentialTail).toBe(true)
    expect(evidence.frameMd5).toBe('tail')
    expect(channel.calls.some(isSelect)).toBe(true)
    expect(await readdir(project)).toEqual(['tail.png'])
  })

  it('fails loud when the written frame cannot be hashed', async () => {
    const project = await tempProject()
    temporary.push(project)
    const channel = tailChannel({ seekWrites: true, imageHashes: ['tail'], videoHashes: ['tail'], imageCode: 1 })
    await expect(extractTailFrame(
      createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
      'C:/proj/video/02/shot_006.mp4',
      join(project, 'tail.png'),
    )).rejects.toThrow('无法读取尾帧')
  })

  it('fails loud when the written frame has no decodable frame', async () => {
    const project = await tempProject()
    temporary.push(project)
    const channel = tailChannel({ seekWrites: true, imageHashes: [], videoHashes: ['tail'] })
    await expect(extractTailFrame(
      createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
      'C:/proj/video/02/shot_006.mp4',
      join(project, 'tail.png'),
    )).rejects.toThrow('解不出任何一帧的 framemd5')
  })

  it('fails loud when the source cannot be decoded sequentially', async () => {
    const project = await tempProject()
    temporary.push(project)
    const channel = tailChannel({ seekWrites: true, imageHashes: ['tail'], videoHashes: [], videoCode: 1 })
    await expect(extractTailFrame(
      createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
      'C:/proj/video/02/shot_006.mp4',
      join(project, 'tail.png'),
    )).rejects.toThrow('无法顺序解码')
  })

  it('fails loud when the source yields no frame at all', async () => {
    const project = await tempProject()
    temporary.push(project)
    const channel = tailChannel({ seekWrites: true, imageHashes: ['tail'], videoHashes: [] })
    await expect(extractTailFrame(
      createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
      'C:/proj/video/02/shot_006.mp4',
      join(project, 'tail.png'),
    )).rejects.toThrow('顺序解码没有得到任何一帧')
  })

  it('propagates a stat failure that is not a missing file', async () => {
    const channel = tailChannel({ seekWrites: true, imageHashes: ['tail'], videoHashes: ['tail'] })
    await expect(extractTailFrame(
      createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
      'C:/proj/video/02/shot_006.mp4',
      'bad\0path.png',
    )).rejects.toThrow()
  })
})
describe('requireEndingAssetFile', () => {
  it('does not classify an unreadable sibling as a verified installed asset', async () => {
    const project = await tempProject()
    temporary.push(project)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(project, 'ending_audio.mp3'))
    await expect(requireEndingAssetFile(join(project, 'ending_effect.mp4'), ENDING_EFFECT_ASSET, ENDING_AUDIO_ASSET))
      .rejects.toThrow('不是随包 assets 目录')
  })
  it('accepts a readable file wherever the caller put it', async () => {
    const project = await tempProject()
    temporary.push(project)
    const effect = join(project, 'ending_effect.mp4')
    await copyFile(shippedEndingAsset('ending_effect.mp4'), effect)
    await expect(requireEndingAssetFile(effect, ENDING_EFFECT_ASSET, ENDING_AUDIO_ASSET))
      .resolves.toBeUndefined()
  })

  it('names the installed product when the shipped directory holds the sibling but not the file', async () => {
    const project = await tempProject()
    temporary.push(project)
    // The shipped ending files share one directory: the sibling's shipped bytes
    // prove the directory arrived, so only this file can be the missing one.
    await copyFile(shippedEndingAsset('ending_audio.mp3'), join(project, 'ending_audio.mp3'))
    const missing = join(project, 'ending_effect.mp4')
    const failure = requireEndingAssetFile(missing, ENDING_EFFECT_ASSET, ENDING_AUDIO_ASSET)
    await expect(failure).rejects.toThrow('片尾特效不存在或不可读')
    await expect(failure).rejects.toThrow('技能素材目录已随包安装')
    await expect(failure).rejects.toThrow(ENDING_EFFECT_ASSET.sha256)
  })

  it('names a wrong path when the directory holds neither shipped file', async () => {
    const project = await tempProject()
    temporary.push(project)
    const failure = requireEndingAssetFile(join(project, 'exports', 'effect.mp4'), ENDING_EFFECT_ASSET, ENDING_AUDIO_ASSET)
    await expect(failure).rejects.toThrow('不存在或不可读')
    await expect(failure).rejects.toThrow('不是随包 assets 目录')
  })

  it('rejects an empty shipped file by name', async () => {
    const project = await tempProject()
    temporary.push(project)
    const empty = join(project, 'ending_effect.mp4')
    await writePlaceholder(empty, '')
    await expect(requireEndingAssetFile(empty, ENDING_EFFECT_ASSET, ENDING_AUDIO_ASSET))
      .rejects.toThrow('片尾特效是空文件')
  })
})

describe('requireShippedEndingAsset', () => {
  it('accepts the shipped ending effect and the shipped ending sound', async () => {
    await expect(requireShippedEndingAsset(shippedEndingAsset('ending_effect.mp4'), ENDING_EFFECT_ASSET))
      .resolves.toBeUndefined()
    await expect(requireShippedEndingAsset(shippedEndingAsset('ending_audio.mp3'), ENDING_AUDIO_ASSET))
      .resolves.toBeUndefined()
  })

  it('rejects a substituted ending effect and names the shipped asset', async () => {
    const project = await tempProject()
    temporary.push(project)
    const wrong = join(project, 'ending_effect.mp4')
    await writePlaceholder(wrong, 'not the shipped effect')
    await expect(requireShippedEndingAsset(wrong, ENDING_EFFECT_ASSET))
      .rejects.toThrow('片尾特效不是随包素材')
    await expect(requireShippedEndingAsset(wrong, ENDING_EFFECT_ASSET))
      .rejects.toThrow(ENDING_EFFECT_ASSET.sha256)
    await expect(requireShippedEndingAsset(wrong, ENDING_EFFECT_ASSET))
      .rejects.toThrow('tweet-drama-background-render/assets/ending_effect.mp4')
  })

  it('rejects a substituted ending sound and names the shipped asset', async () => {
    const project = await tempProject()
    temporary.push(project)
    const wrong = join(project, 'ending_audio.mp3')
    await writePlaceholder(wrong, 'not the shipped sound')
    await expect(requireShippedEndingAsset(wrong, ENDING_AUDIO_ASSET))
      .rejects.toThrow('片尾音不是随包素材')
    await expect(requireShippedEndingAsset(wrong, ENDING_AUDIO_ASSET))
      .rejects.toThrow(ENDING_AUDIO_ASSET.sha256)
    await expect(requireShippedEndingAsset(wrong, ENDING_AUDIO_ASSET))
      .rejects.toThrow('tweet-drama-background-render/assets/ending_audio.mp3')
  })
})

describe('requireEndingEffectFits', () => {
  /** The toolkit one duration check talks to. */
  function probingToolkit(path: string, durationSeconds: number) {
    const channel = stubChannel([probeHandler({ [path]: { durationSeconds } })])
    return createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel })
  }

  it('accepts the shipped effect, which is shorter than the ending window', async () => {
    const effect = shippedEndingAsset('ending_effect.mp4')
    await expect(requireEndingEffectFits(probingToolkit(effect, 1.02), effect)).resolves.toBeUndefined()
  })

  it('accepts an effect that ends exactly on the ending window', async () => {
    const effect = 'C:/proj/assets/ending_effect.mp4'
    await expect(requireEndingEffectFits(probingToolkit(effect, ENDING_SECONDS), effect)).resolves.toBeUndefined()
  })

  it('rejects an effect longer than the ending window instead of truncating it', async () => {
    const effect = 'C:/proj/assets/longer_effect.mp4'
    await expect(requireEndingEffectFits(probingToolkit(effect, 2.5), effect)).rejects.toThrow('超过片尾 2.000 秒的窗口')
  })

  it('fails loud when the effect cannot be probed at all', async () => {
    const effect = 'C:/proj/assets/unreadable_effect.mp4'
    await expect(requireEndingEffectFits(probingToolkit(effect, 1.02), effect + '.other'))
      .rejects.toThrow('ffprobe')
  })
})

describe('buildEndingClip', () => {
  it('loops the frozen frame for exactly two seconds and blends the effect over it', async () => {
    const project = await tempProject()
    temporary.push(project)
    const target = join(project, 'ending.mp4')
    const channel = stubChannel([call => ({ after: async () => { await writePlaceholder(call.args[call.args.length - 1] ?? '', 'mp4') } })])
    await buildEndingClip(
      createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
      join(project, 'tail.png'),
      'assets/ending_effect.mp4',
      target,
      'libx264',
      ['-preset', 'medium'],
    )
    expect(channel.calls[0]?.args.slice(0, 6)).toEqual(['-y', '-v', 'error', '-loop', '1', '-i'])
    expect(channel.calls[0]?.args).toContain('2.000')
    expect(channel.calls[0]?.args).toContain('libx264')
    expect(await sizeOf(target)).toBe(3)
  })
})

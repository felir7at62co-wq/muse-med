/** The fixed delivery style: geometry, encoder arguments, subtitle burn, and the audio mix. */

import { describe, expect, it } from 'vitest'
import {
  buildAssHeader,
  audioMixFilter,
  BUFFER_SIZE,
  DELIVERY_FPS,
  DELIVERY_HEIGHT,
  DELIVERY_WIDTH,
  deliveryScaleFilter,
  EFFECT_BLEND_OPACITY,
  ENCODER_PROBE_SOURCE,
  encoderArguments,
  ENDING_AUDIO_ASSET,
  ENDING_EFFECT_ASSET,
  ENDING_SECONDS,
  endingEffectFilter,
  escapeAssText,
  formatAssTime,
  MAX_BITRATE,
  MIN_BITRATE_BPS,
  subtitleBurnFilter,
  TARGET_BITRATE,
  WATERMARK_POSITION,
  WATERMARK_TEXT,
} from '../src/delivery.ts'

describe('the delivery constants', () => {
  it('fix the picture geometry the platform requires', () => {
    expect(DELIVERY_WIDTH).toBe(1440)
    expect(DELIVERY_HEIGHT).toBe(2560)
    expect(DELIVERY_FPS).toBe(60)
    expect(TARGET_BITRATE).toBe('24M')
    expect(MAX_BITRATE).toBe('30M')
    expect(BUFFER_SIZE).toBe('48M')
    expect(MIN_BITRATE_BPS).toBe(4_600_000)
  })

  it('fix the ending and the AI-content mark', () => {
    expect(ENDING_SECONDS).toBe(2)
    expect(EFFECT_BLEND_OPACITY).toBe('0.90')
    expect(WATERMARK_TEXT).toBe('内容由AI生成')
    expect(WATERMARK_POSITION).toBe('{\\an3\\pos(1025,1810)}')
  })

  it('accepts only the shipped ending assets, by the bytes they ship with', () => {
    expect(ENDING_EFFECT_ASSET).toEqual({
      label: '片尾特效',
      file: 'tweet-drama-background-render/assets/ending_effect.mp4',
      sha256: '49308bce84b964c5ec6768655e84920731dcaabe14509a0d84b4c92aea590010',
    })
    expect(ENDING_AUDIO_ASSET).toEqual({
      label: '片尾音',
      file: 'tweet-drama-background-render/assets/ending_audio.mp3',
      sha256: 'd1649e9c9231283a93ee3d28816c741ac3d389528654fca5ac69d75139943c0f',
    })
  })

  it('puts the probe on a source NVENC accepts', () => {
    expect(ENCODER_PROBE_SOURCE).toBe('color=black:s=256x256:d=0.1')
  })

  it('keeps the subtitle style inside the ASS header', () => {
    const ASS_DOCUMENT_HEADER = buildAssHeader({ subtitleFontFamily: 'SimHei', watermarkFontFamily: 'Microsoft YaHei' })
    expect(ASS_DOCUMENT_HEADER).toContain('PlayResX: 1080')
    expect(ASS_DOCUMENT_HEADER).toContain('PlayResY: 1920')
    expect(ASS_DOCUMENT_HEADER).toContain('WrapStyle: 2')
    expect(ASS_DOCUMENT_HEADER.endsWith('[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n'))
      .toBe(true)
  })
})

describe('deliveryScaleFilter', () => {
  it('fills the delivery frame and fixes the pixel format', () => {
    expect(deliveryScaleFilter()).toBe('scale=1440:2560:force_original_aspect_ratio=increase,crop=1440:2560,fps=60,format=yuv420p')
  })

  it('uses the requested format when the frame is blended instead of encoded', () => {
    expect(deliveryScaleFilter('gbrp')).toContain('format=gbrp')
  })
})

describe('encoderArguments', () => {
  it('gives the GPU encoder its preset, rate control, and quality target', () => {
    expect(encoderArguments('h264_nvenc')).toEqual([
      '-preset', 'p5', '-rc', 'vbr', '-cq', '19',
      '-b:v', '24M', '-maxrate', '30M', '-bufsize', '48M',
      '-g', '120', '-profile:v', 'high', '-level', '5.1',
    ])
  })

  it('gives the CPU encoder the same rate control without NVENC options', () => {
    expect(encoderArguments('libx264')).toEqual([
      '-preset', 'medium',
      '-b:v', '24M', '-maxrate', '30M', '-bufsize', '48M',
      '-g', '120', '-profile:v', 'high', '-level', '5.1',
    ])
  })
})

describe('endingEffectFilter', () => {
  it('plays the effect at its own speed, then leaves the freeze frame for the rest of the ending', () => {
    const filter = endingEffectFilter()
    expect(filter.startsWith('[0:v]scale=1440:2560:force_original_aspect_ratio=increase,crop=1440:2560,fps=60,format=gbrp[base];'))
      .toBe(true)
    expect(filter).toContain('[1:v]setpts=PTS-STARTPTS,')
    expect(filter).not.toContain('setpts=(PTS-STARTPTS)/')
    expect(filter).toContain("tmix=frames=2:weights='1 1',")
    expect(filter).toContain('tpad=stop_mode=add:stop_duration=2.000:color=black,')
    expect(filter).toContain('trim=0:2.000,fps=60,scale=1440:2560:flags=lanczos,')
    expect(filter.endsWith('[base][fx]blend=all_mode=screen:all_opacity=0.90:shortest=1,format=yuv420p[v]')).toBe(true)
  })

  it('keeps the effect branch exactly as long as the ending window', () => {
    const filter = endingEffectFilter()
    const effectBranch = filter.slice(filter.indexOf('[1:v]'), filter.indexOf('[fx]'))
    expect(effectBranch).toContain(`trim=0:${ENDING_SECONDS.toFixed(3)}`)
    expect(effectBranch).toContain(`tpad=stop_mode=add:stop_duration=${ENDING_SECONDS.toFixed(3)}`)
  })
})

describe('subtitleBurnFilter', () => {
  it('doubles the frame for libass and escapes both paths', () => {
    expect(subtitleBurnFilter('C:\\proj\\exports\\display.ass', 'C:\\Windows\\Fonts'))
      .toBe("scale=2880:5120:flags=lanczos,ass='C\\:/proj/exports/display.ass':fontsdir='C\\:/Windows/Fonts',scale=1440:2560:flags=lanczos")
  })
})

describe('audioMixFilter', () => {
  it('pads the master, cuts the BGM at the body end, delays the ending sound, and limits the mix', () => {
    const filter = audioMixFilter({
      bodyEndSeconds: 114.733332,
      totalSeconds: 116.733332,
      endingSeconds: 2,
      masterVolume: 1.45,
      bgmVolume: 0.24,
    })
    expect(filter).toBe(
      '[1:a]apad,atrim=0:116.733332,volume=1.45[a0];'
      + '[2:a]atrim=0:114.733332,volume=0.24[a1];'
      + '[3:a]atrim=0:2.000000,adelay=114733|114733,volume=1[a2];'
      + '[a0][a1][a2]amix=inputs=3:duration=longest:normalize=0,'
      + 'atrim=0:116.733332,alimiter=limit=0.95:level=false[a]',
    )
  })
})

describe('formatAssTime', () => {
  it('formats sub-minute timestamps with two fractional digits', () => {
    expect(formatAssTime(1.68)).toBe('0:00:01.68')
  })

  it('rolls a rounded value into the next second', () => {
    expect(formatAssTime(59.999)).toBe('0:00:60.00')
  })

  it('carries hours', () => {
    expect(formatAssTime(3725.5)).toBe('1:02:05.50')
  })
})

describe('escapeAssText', () => {
  it('replaces both braces with full-width parentheses', () => {
    expect(escapeAssText('{\\b1}粗体{\\b0}')).toBe('（\\b1）粗体（\\b0）')
  })
})

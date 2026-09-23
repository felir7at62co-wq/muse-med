/**
 * The fixed delivery style: picture geometry, rate control, subtitle style,
 * ending effect, and the audio mix graph.
 *
 * These values are the operator-approved delivery specification, not
 * deployment-varying choices, so they live here as constants and every method
 * builds its commands from them. What does vary per deployment — the binaries,
 * the two audio gains, the font directory and families — is validated by the
 * plugin's Config.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/delivery
 */

import { escapeFilterPath } from './ffmpeg.ts'
import type { AudioMixSpec, RenderSettings } from './types.ts'

/** Delivered picture width in pixels. */
export const DELIVERY_WIDTH = 1440

/** Delivered picture height in pixels. */
export const DELIVERY_HEIGHT = 2560

/** Delivered frame rate. */
export const DELIVERY_FPS = 60

/** Video target bitrate. */
export const TARGET_BITRATE = '24M'

/** Video peak bitrate. */
export const MAX_BITRATE = '30M'

/** Rate-control buffer size. */
export const BUFFER_SIZE = '48M'

/**
 * Overall bitrate floor a delivered episode must reach.
 *
 * A render that lands below this is a failed delivery even when every stream is
 * correct: the platform re-encodes what it receives, and a starved master loses
 * the detail the 1440x2560 master exists to carry.
 */
export const MIN_BITRATE_BPS = 4_600_000

/** Seconds the ending freeze occupies. */
export const ENDING_SECONDS = 2

/** How much of the ending effect's own timeline one second of the freeze consumes. */
export const EFFECT_SPEED = '0.729'

/** The ending effect's blend opacity over the frozen frame. */
export const EFFECT_BLEND_OPACITY = '0.90'

/** Where the AI-content mark sits on the 1080x1920 script canvas. */
export const WATERMARK_POSITION = '{\\an3\\pos(1025,1810)}'

/** The text the delivery spec requires in the bottom-right corner. */
export const WATERMARK_TEXT = '内容由AI生成'

/** Keyframe interval in frames. */
const KEYFRAME_INTERVAL = DELIVERY_FPS * 2

/**
 * Compose the ASS styles and event format with deployment-selected fonts.
 * @param settings - Font families validated by the plugin Config.
 * @returns The ASS header, including the event format line.
 */
export function buildAssHeader(settings: Pick<RenderSettings, 'subtitleFontFamily' | 'watermarkFontFamily'>): string {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,${settings.subtitleFontFamily},68,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,-2,0,1,7,0,2,40,40,520,1
Style: Watermark,${settings.watermarkFontFamily},44,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,20,20,20,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`
}

/**
 * The filter every body clip and the ending frame pass through.
 *
 * `increase` plus `crop` fills the delivery frame from any source aspect ratio
 * without letterboxing, and the pixel format is fixed to what the encoder and
 * the blend expect.
 * @param pixelFormat - The format the chain ends in; `gbrp` when the frame is blended instead of encoded.
 * @returns The scale, crop, frame-rate, and pixel-format chain.
 */
export function deliveryScaleFilter(pixelFormat = 'yuv420p'): string {
  return `scale=${String(DELIVERY_WIDTH)}:${String(DELIVERY_HEIGHT)}:force_original_aspect_ratio=increase,`
    + `crop=${String(DELIVERY_WIDTH)}:${String(DELIVERY_HEIGHT)},fps=${String(DELIVERY_FPS)},format=${pixelFormat}`
}

/**
 * The rate-control and profile arguments one encoder takes.
 * @param encoder - `h264_nvenc` or `libx264`.
 * @returns The arguments that follow `-c:v <encoder>`.
 */
export function encoderArguments(encoder: string): string[] {
  const rateControl = [
    '-b:v', TARGET_BITRATE, '-maxrate', MAX_BITRATE, '-bufsize', BUFFER_SIZE,
    '-g', String(KEYFRAME_INTERVAL), '-profile:v', 'high', '-level', '5.1',
  ]
  return encoder === 'h264_nvenc'
    ? ['-preset', 'p5', '-rc', 'vbr', '-cq', '19', ...rateControl]
    : ['-preset', 'medium', ...rateControl]
}

/** The lavfi source the encoder probe encodes one frame of. */
export const ENCODER_PROBE_SOURCE = 'color=black:s=256x256:d=0.1'

/**
 * The filter graph that turns the frozen tail frame and the ending effect into
 * the ending clip.
 *
 * The effect is sped up to {@link EFFECT_SPEED}, interpolated to 120 fps and
 * blended back to 60, then screen-blended over the freeze at
 * {@link EFFECT_BLEND_OPACITY}; the freeze itself is a single still, so the
 * ending's length is exactly the trim, independent of the effect's own duration.
 * @returns The filter graph, whose only output pad is `[v]`.
 */
export function endingEffectFilter(): string {
  return `[0:v]${deliveryScaleFilter('gbrp')}[base];`
    + `[1:v]setpts=(PTS-STARTPTS)/${EFFECT_SPEED},`
    + 'scale=540:960:force_original_aspect_ratio=increase,'
    + 'crop=540:960,minterpolate=fps=120:mi_mode=mci:mc_mode=aobmc:me_mode=bidir,'
    + "tmix=frames=2:weights='1 1',"
    + `tpad=stop_mode=add:stop_duration=${ENDING_SECONDS.toFixed(3)}:color=black,`
    + `trim=0:${ENDING_SECONDS.toFixed(3)},fps=${String(DELIVERY_FPS)},`
    + `scale=${String(DELIVERY_WIDTH)}:${String(DELIVERY_HEIGHT)}:flags=lanczos,`
    + 'eq=contrast=1.28:brightness=-0.14:saturation=1.15,format=gbrp[fx];'
    + `[base][fx]blend=all_mode=screen:all_opacity=${EFFECT_BLEND_OPACITY}:shortest=1,format=yuv420p[v]`
}

/**
 * The filter that burns the ASS script into the picture.
 *
 * The frame is doubled before libass runs and halved afterwards, so the 1080x1920
 * script canvas is rasterized at twice its declared size; the delivered picture
 * keeps the script's own geometry.
 * @param assPath - Absolute path of the ASS script to burn.
 * @param fontsDir - Directory libass resolves the style's font from.
 * @returns The scale, subtitles, and scale chain.
 */
export function subtitleBurnFilter(assPath: string, fontsDir: string): string {
  return `scale=${String(DELIVERY_WIDTH * 2)}:${String(DELIVERY_HEIGHT * 2)}:flags=lanczos,`
    + `ass='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(fontsDir)}',`
    + `scale=${String(DELIVERY_WIDTH)}:${String(DELIVERY_HEIGHT)}:flags=lanczos`
}

/**
 * The graph that mixes the episode's own master, the BGM bed, and the ending
 * sound into the delivered audio.
 *
 * Input 0 is the picture, 1 the master audio, 2 the BGM, and 3 the ending sound;
 * the ending is delayed to the body end and never mixed over the body, the BGM is
 * cut at the body end rather than run under the ending, and the master is padded
 * to the total so `amix` cannot end early. `normalize=0` keeps every gain the
 * caller's own, and the limiter is the delivery spec's final ceiling.
 * @param spec - The boundaries and gains this mix uses.
 * @returns The filter graph, whose only output pad is `[a]`.
 */
export function audioMixFilter(spec: AudioMixSpec): string {
  const total = spec.totalSeconds.toFixed(6)
  const body = spec.bodyEndSeconds.toFixed(6)
  const delayMs = Math.round(spec.bodyEndSeconds * 1000)
  return `[1:a]apad,atrim=0:${total},volume=${String(spec.masterVolume)}[a0];`
    + `[2:a]atrim=0:${body},volume=${String(spec.bgmVolume)}[a1];`
    + `[3:a]atrim=0:${spec.endingSeconds.toFixed(6)},adelay=${String(delayMs)}|${String(delayMs)},volume=1[a2];`
    + '[a0][a1][a2]amix=inputs=3:duration=longest:normalize=0,'
    + `atrim=0:${total},alimiter=limit=0.95:level=false[a]`
}

/** One ASS timestamp: `H:MM:SS.cc` with two fractional digits. */
interface AssTimestamp {
  /** Hours, unpadded. */
  readonly hours: number
  /** Minutes, padded to two digits by the caller. */
  readonly minutes: number
  /** Seconds with two fractional digits, padded to five characters. */
  readonly seconds: string
}

/** Split decimal seconds into the three ASS fields. */
function splitAssTime(seconds: number): AssTimestamp {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return { hours, minutes, seconds: rest.toFixed(2).padStart(5, '0') }
}

/**
 * Format one ASS timestamp.
 * @param seconds - Seconds from the episode start.
 * @returns `H:MM:SS.cc`, the form the ASS event lines carry.
 */
export function formatAssTime(seconds: number): string {
  const { hours, minutes, seconds: rest } = splitAssTime(seconds)
  return `${String(hours)}:${String(minutes).padStart(2, '0')}:${rest}`
}

/**
 * Escape one cue's text for the ASS event line.
 *
 * Braces open an override block in ASS, so a literal brace in the subtitle would
 * otherwise be read as markup and silently drop the text around it.
 * @param text - The cue text.
 * @returns The text with braces replaced by full-width parentheses.
 */
export function escapeAssText(text: string): string {
  return text.replace(/\{/g, '（').replace(/\}/g, '）')
}

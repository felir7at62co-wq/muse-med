/**
 * Delivery defaults, rate control, subtitle style, ending effect, and audio mix.
 * Geometry is supplied by the validated timeline snapshot. Deployment-selected
 * binaries, gains, font directory and font families remain plugin Config fields.
 *
 * @module @deepseek-ai/dsh-tool-episode-render/delivery
 */

import { escapeFilterPath } from './ffmpeg.ts'
import type { AudioMixSpec, RenderSettings, TimelineDelivery } from './types.ts'

/** Delivered picture width in pixels. */
export const DELIVERY_WIDTH = 1440

/** Delivered picture height in pixels. */
export const DELIVERY_HEIGHT = 2560

/** Delivered frame rate. */
export const DELIVERY_FPS = 60

/** Geometry used by legacy timelines and omitted project delivery fields. */
export const DEFAULT_DELIVERY: TimelineDelivery = { width: DELIVERY_WIDTH, height: DELIVERY_HEIGHT, fps: DELIVERY_FPS }

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

/**
 * Seconds the ending occupies, and the frozen frame behind it.
 *
 * The effect plays once at its own speed over the opening of this window; every
 * remaining frame of the ending is the freeze frame, unchanged.
 */
export const ENDING_SECONDS = 2

/** The ending effect's blend opacity over the frozen frame. */
export const EFFECT_BLEND_OPACITY = '0.90'

/**
 * One ending asset the delivery spec ships, and the only bytes it accepts.
 *
 * `render` is given a path for each of the two ending files, so the file is
 * accepted on its content rather than on where it was found: the supplied bytes
 * are the asset exactly when their SHA-256 is the shipped one.
 */
export interface ShippedEndingAsset {
  /** What the model-facing diagnostic calls this asset. */
  readonly label: string
  /** Path of the asset inside the `tweet-drama-background-render` skill package. */
  readonly file: string
  /** Lowercase SHA-256 of the shipped bytes. */
  readonly sha256: string
}

/** The shipped ending effect: 1.020 seconds, played once at its own speed. */
export const ENDING_EFFECT_ASSET: ShippedEndingAsset = {
  label: '片尾特效',
  file: 'tweet-drama-background-render/assets/ending_effect.mp4',
  sha256: '49308bce84b964c5ec6768655e84920731dcaabe14509a0d84b4c92aea590010',
}

/** The shipped ending sound: 3.474 seconds, of which the ending plays the first 2. */
export const ENDING_AUDIO_ASSET: ShippedEndingAsset = {
  label: '片尾音',
  file: 'tweet-drama-background-render/assets/ending_audio.mp3',
  sha256: 'd1649e9c9231283a93ee3d28816c741ac3d389528654fca5ac69d75139943c0f',
}

/** Where the AI-content mark sits on the 1080x1920 script canvas. */
export const WATERMARK_POSITION = '{\\an3\\pos(1025,1810)}'

/** The text the delivery spec requires in the bottom-right corner. */
export const WATERMARK_TEXT = '内容由AI生成'

/** ASS script canvas width; every subtitle value is authored in these units. */
export const PLAY_RES_WIDTH = 1080

/** ASS script canvas height; the outline is converted to it by {@link assOutline}. */
export const PLAY_RES_HEIGHT = 1920

/**
 * Black outline the delivered picture must show around body subtitles, in
 * delivered pixels.
 *
 * This is the operator's reading of the style — how wide the band looks on the
 * delivered file — not an ASS field. `Outline` is in script-canvas units and
 * libass scales it to the rasterized frame, so the field value is derived from
 * this target rather than written beside it.
 */
export const SUBTITLE_OUTLINE_TARGET_PX = 7

/**
 * Derive the ASS `Outline` value that renders at a target width.
 *
 * With `ScaledBorderAndShadow: yes` — which {@link buildAssHeader} writes —
 * libass scales a style's outline by the frame height it rasterizes over the
 * script's own height, so the delivered band is
 * `Outline x outputHeight / PlayResY`. The burn stage's 2x supersample cancels
 * exactly (it doubles the raster and the shrink halves it back), so the same
 * field renders the same band whether the script is burned at the delivery size
 * or doubled. The field is written as an integer because that is the resolution
 * the style line has always carried.
 *
 * Measured on the standard geometry (target 7, derived 5, SimHei 68 burned
 * through {@link subtitleBurnFilter}): the band's thinnest run is 5px and its
 * median run 7px, the same in the supersampled burn and in a direct burn at the
 * delivery size. Omitting `ScaledBorderAndShadow` is what made the older fixed
 * values unreadable: libass then draws the outline unscaled in raster pixels,
 * and the supersample halves it again — the old `Outline 3` rendered a 1-2px
 * band, and the note that set it measured its 4px on a direct burn instead.
 * @param targetPx - The delivered band width the picture must show.
 * @param playResY - The script canvas height the outline is authored against.
 * @param outputHeight - The delivered picture height.
 * @returns The ASS `Outline` value for the style line.
 */
export function assOutline(targetPx: number, playResY: number, outputHeight: number): number {
  return Math.round(targetPx * playResY / outputHeight)
}

/**
 * Compose the ASS styles and event format with deployment-selected fonts.
 *
 * `ScaledBorderAndShadow: yes` is what makes the style line's `Outline` a width
 * in script-canvas units that {@link assOutline} can derive from the delivered
 * pixels; without it libass treats the value as unscaled raster pixels.
 * @param settings - Font families validated by the plugin Config.
 * @param delivery - Output geometry determining the script canvas and outline.
 * @param addWatermark - Whether to include the watermark style.
 * @returns The ASS header, including the event format line.
 */
export function buildAssHeader(
  settings: Pick<RenderSettings, 'subtitleFontFamily' | 'watermarkFontFamily'>,
  delivery: TimelineDelivery = DEFAULT_DELIVERY,
  addWatermark = true,
): string {
  const canvas = assCanvas(delivery)
  const outline = assOutline(SUBTITLE_OUTLINE_TARGET_PX, canvas.height, delivery.height)
  const watermarkStyle = addWatermark
    ? `Style: Watermark,${settings.watermarkFontFamily},44,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,20,20,20,1\n`
    : ''
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${String(canvas.width)}
PlayResY: ${String(canvas.height)}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,${settings.subtitleFontFamily},68,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,-2,0,1,${String(outline)},0,2,40,40,${String(Math.round(canvas.height * 520 / PLAY_RES_HEIGHT))},1
${watermarkStyle}
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`
}

/**
 * Match the ASS canvas to the delivered aspect ratio with stable short-edge sizing.
 * @param delivery - Validated output geometry.
 * @returns Script width and height; legacy portrait remains 1080x1920.
 */
export function assCanvas(delivery: TimelineDelivery = DEFAULT_DELIVERY): { width: number; height: number } {
  const scale = PLAY_RES_WIDTH / Math.min(delivery.width, delivery.height)
  return { width: Math.round(delivery.width * scale), height: Math.round(delivery.height * scale) }
}

/**
 * The filter every body clip and the ending frame pass through.
 *
 * `increase` plus `crop` fills the delivery frame from any source aspect ratio
 * without letterboxing, and the pixel format is fixed to what the encoder and
 * the blend expect. One frame of EOF hold preserves the last decoded source
 * frame through rate conversion; callers must cap the encoded output duration.
 * @param pixelFormat - The format the chain ends in; `gbrp` when the frame is blended instead of encoded.
 * @param delivery - Output geometry and frame rate.
 * @returns The scale, crop, frame-rate, and pixel-format chain.
 */
export function deliveryScaleFilter(pixelFormat = 'yuv420p', delivery: TimelineDelivery = DEFAULT_DELIVERY): string {
  return `scale=${String(delivery.width)}:${String(delivery.height)}:force_original_aspect_ratio=increase,`
    + `crop=${String(delivery.width)}:${String(delivery.height)},`
    + `tpad=stop_mode=clone:stop_duration=${(1 / delivery.fps).toFixed(9)},fps=${String(delivery.fps)},format=${pixelFormat}`
}

/**
 * The rate-control and profile arguments one encoder takes.
 * @param encoder - `h264_nvenc` or `libx264`.
 * @param fps - Delivery frame rate; the GOP spans two seconds.
 * @returns The arguments that follow `-c:v <encoder>`.
 */
export function encoderArguments(encoder: string, fps = DELIVERY_FPS): string[] {
  const rateControl = [
    '-b:v', TARGET_BITRATE, '-maxrate', MAX_BITRATE, '-bufsize', BUFFER_SIZE,
    '-g', String(fps * 2), '-profile:v', 'high', '-level', '5.1',
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
 * The effect keeps its own timeline — nothing retimes it — so it covers the
 * opening of the ending for as long as it lasts, 1.020 seconds for the shipped
 * asset, and the rest of the window is the freeze frame. What makes that
 * remainder the freeze is the black pad: a black effect frame screens over the
 * frozen frame without changing it, so the ending still runs the full
 * {@link ENDING_SECONDS} even though the effect is shorter. The effect's frames
 * are interpolated to 120 fps and averaged back to 60 before the pad, and the
 * result is screen-blended over the freeze at {@link EFFECT_BLEND_OPACITY}.
 * @param delivery - Output geometry and frame rate.
 * @returns The filter graph, whose only output pad is `[v]`.
 */
export function endingEffectFilter(delivery: TimelineDelivery = DEFAULT_DELIVERY): string {
  const canvas = assCanvas(delivery)
  const effectWidth = Math.round(canvas.width / 2)
  const effectHeight = Math.round(canvas.height / 2)
  return `[0:v]${deliveryScaleFilter('gbrp', delivery)}[base];`
    + '[1:v]setpts=PTS-STARTPTS,'
    + `scale=${String(effectWidth)}:${String(effectHeight)}:force_original_aspect_ratio=increase,`
    + `crop=${String(effectWidth)}:${String(effectHeight)},minterpolate=fps=120:mi_mode=mci:mc_mode=aobmc:me_mode=bidir,`
    + "tmix=frames=2:weights='1 1',"
    + `tpad=stop_mode=add:stop_duration=${ENDING_SECONDS.toFixed(3)}:color=black,`
    + `trim=0:${ENDING_SECONDS.toFixed(3)},`
    + `tpad=stop_mode=clone:stop_duration=${(1 / delivery.fps).toFixed(9)},fps=${String(delivery.fps)},`
    + `scale=${String(delivery.width)}:${String(delivery.height)}:flags=lanczos,`
    + 'eq=contrast=1.28:brightness=-0.14:saturation=1.15,format=gbrp[fx];'
    + `[base][fx]blend=all_mode=screen:all_opacity=${EFFECT_BLEND_OPACITY}:shortest=1,format=yuv420p[v]`
}

/**
 * The filter that burns the ASS script into the picture.
 *
 * The frame is doubled before libass runs and halved afterwards, so the 1080x1920
 * script canvas is rasterized at twice its declared size; the delivered picture
 * keeps the script's own geometry.
 *
 * `fps` and `setpts` come last, after the burn: the burn runs on the source's own
 * time base, so a frame-rate change placed before it does not survive into the
 * encode — a chain that regularized the rate first still produced a file whose
 * container reported the delivery rate while only a third of its frames decoded.
 * Ending the chain with `fps` plus a timestamp rewrite is what makes the burned
 * stream constant-rate and anchored at zero before the encoder sees it.
 * One frame of EOF hold preserves the decoded tail; callers must cap the burn
 * to the declared delivery duration and set the output frame rate explicitly.
 * @param assPath - Absolute path of the ASS script to burn.
 * @param fontsDir - Directory libass resolves the style's font from.
 * @param delivery - Output geometry and frame rate.
 * @returns The scale, subtitles, scale, and frame-rate chain.
 */
export function subtitleBurnFilter(assPath: string, fontsDir: string, delivery: TimelineDelivery = DEFAULT_DELIVERY): string {
  return `scale=${String(delivery.width * 2)}:${String(delivery.height * 2)}:flags=lanczos,`
    + `ass='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(fontsDir)}',`
    + `scale=${String(delivery.width)}:${String(delivery.height)}:flags=lanczos,`
    + `tpad=stop_mode=clone:stop_duration=${(1 / delivery.fps).toFixed(9)},`
    + `fps=${String(delivery.fps)},setpts=N/(${String(delivery.fps)}*TB)`
}

/**
 * The graph that mixes the episode's own master, the BGM bed, and the ending
 * sound into the delivered audio.
 *
 * Input 0 is the picture, 1 the master audio, 2 the BGM, and optionally 3 the ending sound;
 * a zero-length ending omits that input entirely. The ending is delayed to the body end, the BGM is
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
  const ending = spec.endingSeconds > 0
    ? `[3:a]atrim=0:${spec.endingSeconds.toFixed(6)},adelay=${String(delayMs)}|${String(delayMs)},volume=1[a2];`
      + '[a0][a1][a2]amix=inputs=3:duration=longest:normalize=0,'
    : '[a0][a1]amix=inputs=2:duration=longest:normalize=0,'
  return `[1:a]apad,atrim=0:${total},volume=${String(spec.masterVolume)}[a0];`
    + `[2:a]atrim=0:${body},volume=${String(spec.bgmVolume)}[a1];`
    + ending
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

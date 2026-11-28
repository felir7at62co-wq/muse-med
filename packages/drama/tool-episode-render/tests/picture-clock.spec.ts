import { describe, expect, it } from 'vitest'
import { deliveryPictureClockSchema, planDeliveryPictureClock, requirePictureFrameGrid } from '../src/picture-clock.ts'
import type { MediaToolkit } from '../src/types.ts'

function probe(timestamps: readonly number[], stderr = ''): MediaToolkit {
  return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: { run: async () => ({ code: 0, stderr,
    stdout: JSON.stringify({
      streams: [{ time_base: '1/15360', avg_frame_rate: '60/1', r_frame_rate: '60/1', duration_ts: 1024, nb_frames: '4' }],
      frames: timestamps.map(pts => ({ pts })),
    }),
  }) } }
}

describe('exact native picture clock', () => {
  it('does not advertise a picture clock for unsupported or discontinuous timelines', () => {
    const clip = { shot: 1, startUs: 0, durationUs: 1_000_000 }
    expect(planDeliveryPictureClock([clip], 7_201, 0)).toBeUndefined()
    expect(planDeliveryPictureClock([clip], 120, 0)?.total_frames).toBe(120)
    expect(planDeliveryPictureClock([clip], 60, 120)).toBeUndefined()
    expect(planDeliveryPictureClock([{ ...clip, startUs: 1 }], 60, 0)).toBeUndefined()
  })

  it('rejects a receipt whose microsecond and frame endpoints disagree', () => {
    const clip = { shot: 1, startUs: 0, durationUs: 100_000 }
    const clock = planDeliveryPictureClock([clip], 60, 0)
    expect(deliveryPictureClockSchema.safeParse(clock).success).toBe(true)
    expect(deliveryPictureClockSchema.safeParse({ ...clock, body_end_us: 100_001 }).success).toBe(false)
  })

  it('uses the first frame after a non-grid cut and preserves the exact serialized boundary', () => {
    const clock = planDeliveryPictureClock([{ shot: 1, startUs: 0, durationUs: 100_001 },
      { shot: 2, startUs: 100_001, durationUs: 16_666 }, { shot: 3, startUs: 116_667, durationUs: 16_666 }], 60, 0)
    // The first two authored cuts would fall on the same frame and cannot both be authoritative.
    expect(clock).toBeUndefined()
    const separate = planDeliveryPictureClock([{ shot: 1, startUs: 0, durationUs: 100_001 },
      { shot: 2, startUs: 100_001, durationUs: 33_332 }], 60, 0)
    expect(separate?.clips.map(clip => clip.end_frame)).toEqual([7, 8])
  })

  it('requires the actual entire decoded clock even when nominal rate, count, and duration agree', async () => {
    await expect(requirePictureFrameGrid(probe([0, 256, 512, 768]), 'video.mp4', 60, 4)).resolves.toBeUndefined()
    await expect(requirePictureFrameGrid(probe([0, 256, 513, 768]), 'video.mp4', 60, 4))
      .rejects.toMatchObject({ code: 'RENDER_FRAME_CLOCK' })
    await expect(requirePictureFrameGrid(probe([0, 256, 512, 768], 'Decode failure'), 'video.mp4', 60, 4))
      .rejects.toMatchObject({ code: 'RENDER_FRAME_CLOCK' })
  })
})

import { z } from 'zod';
import { PLATFORMS } from './types.ts';

/** Validates a stored platform key. */
export const platformSchema = z.enum(PLATFORMS);

const metricSchema = z.object({ key: z.string().min(1).max(80), label: z.string().min(1).max(80), value: z.number().finite().nullable(), unit: z.string().max(30).optional() });
/** Validates source work metadata shared by ingestion and persisted display snapshots. */
export const workSchema = z.object({
  id: z.string().min(1).max(240), sourceId: z.string().min(1).max(160),
  platform: platformSchema, kind: z.enum(['drama', 'novel']),
  title: z.string().trim().min(1).max(500).nullable(), author: z.string().max(500).nullable(),
  description: z.string().max(30_000), coverUrl: z.string().url().nullable(), sourceUrl: z.string().url(),
  tags: z.array(z.string().max(120)).max(100), category: z.string().max(200),
  episodeCount: z.number().int().nonnegative().nullable(), wordCount: z.number().int().nonnegative().nullable(),
  serialStatus: z.string().max(100).nullable(), publishedAt: z.string().datetime({ offset: true }).nullable(),
  metrics: z.array(metricSchema).max(40), rank: z.number().int().positive().nullable(), rankChange: z.number().int().nullable(),
  board: z.string().max(200), origin: z.enum(['live', 'demo']),
  observedAt: z.string().datetime({ offset: true }), sourceUpdatedAt: z.string().max(200).nullable(),
  metricsObservedAt: z.string().datetime({ offset: true }).optional(),
  metadataStatus: z.enum(['verified', 'unavailable']).optional(), metadataNote: z.string().max(1000).optional(),
}).superRefine((work, context) => {
  if (work.title === null && (work.metadataStatus !== 'unavailable' || !work.metadataNote?.trim())) {
    context.addIssue({ code: 'custom', path: ['title'], message: '缺失作品名称必须明确标注资料不可用及来源说明' });
  }
});

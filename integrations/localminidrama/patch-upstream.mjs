/** Apply Muse's small, pinned companion corrections without modifying provider APIs. */
import { readFileSync, writeFileSync, lstatSync, unlinkSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { planModelSelection } from './compatibility/model-selection.mjs'
import { planStoryboardCompatibility } from './compatibility/storyboards.mjs'
import { planVerification } from './compatibility/verification.mjs'
import { planMediaAdoption } from './compatibility/media-adoption.mjs'
import { planAssetMedia } from './compatibility/asset-media.mjs'
import { planReferences } from './compatibility/references.mjs'
import { planVideoInputs } from './compatibility/video-inputs.mjs'
import { planEmbeddedStudio } from './compatibility/embedded-studio.mjs'
import { planMuseBranding, museBrandingRemovals } from './compatibility/muse-branding.mjs'
import { planCloudPrefix } from './compatibility/cloud-prefix.mjs'
import { planMuseAudio } from './compatibility/muse-audio.mjs'
import { planRuntimeDependencies } from './compatibility/runtime-dependencies.mjs'
import { planMuseRevisions } from './compatibility/muse-revisions.mjs'
import { planPostproduction } from './compatibility/muse-postproduction.mjs'
import { planMuseAdmission } from './compatibility/muse-admission.mjs'
import { planModelCapabilities } from './compatibility/model-capabilities.mjs'
import { planMuseEpisodePackages } from './compatibility/muse-episode-packages.mjs'
import { planEpisodeMerge } from './compatibility/episode-merge.mjs'
import { planMuseBudget } from './compatibility/muse-budget.mjs'
import { planMuseEditCas } from './compatibility/muse-edit-cas.mjs'
import { planMuseProductionPlan } from './compatibility/muse-production-plan.mjs'
import { planMuseStudio } from './compatibility/muse-studio.mjs'
import { planMuseStudioNative } from './compatibility/muse-studio-native.mjs'
import { planMuseGeneration } from './compatibility/muse-generation.mjs'
import { planMuseProjectArchive } from './compatibility/muse-project-archive.mjs'
import { planStudioEntry } from './compatibility/studio-entry.mjs'
import { planStudioUx } from './compatibility/studio-ux.mjs'

function replaceOnce(text, before, after, file) {
  if (text.indexOf(before) < 0 || text.indexOf(before) !== text.lastIndexOf(before)) {
    throw new Error(`LocalMiniDrama source does not match the pinned patch: ${file}`)
  }
  return text.replace(before, after)
}

/**
 * Refuse incomplete episode merges and expose persisted generation settings through history reads.
 * @param root - Checkout of the exact upstream revision named by Dockerfile.
 */
export function patchUpstream(root) {
  root = resolve(root)
  const pending = new Map()
  const readSource = path => pending.get(path) ?? readFileSync(path, 'utf8')
  const patch = (file, changes) => {
    const path = join(root, 'backend-node/src/services', file)
    let source = readSource(path).replace(/\r\n/g, '\n')
    for (const [before, after] of changes) source = replaceOnce(source, before, after, file)
    pending.set(path, source)
  }
  patch('videoMergeService.js', [
    ["path.join(require('os').tmpdir(), 'drama-video-merge')", "fs.mkdtempSync(path.join(require('os').tmpdir(), 'muse-lmd-merge-'))"],
    ['if (localPaths.length > 0 && ffmpegAvailable && localPaths.length <= 100)', 'if (localPaths.length === scenes.length && ffmpegAvailable && localPaths.length <= 100)'],
    ['  const finalMergedUrl = mergedRelativePath || mergedUrlFallback;', `  // A partial concatenation or a first-clip fallback is not a delivered episode.
  if (!mergedRelativePath) {
    const error = 'Episode merge failed: every selected clip must be readable and FFmpeg must produce the complete episode.';
    db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', error, mergeId);
    if (taskId) taskService.updateTaskError(db, taskId, error);
    return;
  }
  const finalMergedUrl = mergedRelativePath;`],
  ])
  patch('dramaService.js', [
    ['  const sbUrl = sb ? buildUrl(sb.video_url, sb.local_path) : null;', '  const sbUrl = sb?.video_url ? buildUrl(sb.video_url, null) : null;'],
    ["      continue;\n    }\n    scenes.push({", "      throw new Error('Episode has a storyboard without an adopted video; finish or explicitly remove that storyboard before merging.');\n    }\n    scenes.push({"],
  ])
  const history = fields => fields.map(field => `    ${field}: r.${field} ?? null,`).join('\n')
  patch('videoService.js', [['    image_gen_id: r.image_gen_id,', `${history(['duration', 'aspect_ratio', 'resolution', 'seed', 'camera_fixed', 'watermark', 'first_frame_url', 'last_frame_url', 'reference_image_urls', 'provider_task_id'])}\n    image_gen_id: r.image_gen_id,`]])
  patch('imageService.js', [['    frame_type: r.frame_type ?? undefined,', `${history(['negative_prompt', 'reference_images', 'size', 'quality'])}\n    frame_type: r.frame_type ?? undefined,`]])
  for (const planner of [planModelSelection, planStoryboardCompatibility, planVerification, planMediaAdoption, planAssetMedia, planReferences,
    planVideoInputs, planEmbeddedStudio, planMuseBranding, planCloudPrefix, planMuseAudio, planMuseRevisions,
    planPostproduction, planMuseAdmission, planMuseEpisodePackages, planModelCapabilities, planRuntimeDependencies, planEpisodeMerge,
    planMuseBudget, planMuseEditCas, planMuseProductionPlan,
    planMuseStudio, planMuseStudioNative, planMuseProjectArchive, planStudioEntry, planStudioUx, planMuseGeneration]) {
    for (const [path, source] of planner(root, readSource)) pending.set(path, source)
  }
  const removals = museBrandingRemovals.map(({ path, sha256 }) => {
    const target = join(root, path)
    if (!lstatSync(target).isFile() || createHash('sha256').update(readFileSync(target)).digest('hex') !== sha256) {
      throw new Error(`Muse branding asset does not match the pinned revision: ${path}`)
    }
    return { target, sha256 }
  })
  for (const { target, sha256 } of removals) {
    if (createHash('sha256').update(readFileSync(target)).digest('hex') !== sha256) throw new Error('Muse branding asset changed before publication')
  }
  for (const [path, source] of pending) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
  }
  for (const { target } of removals) unlinkSync(target)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: node patch-upstream.mjs <upstream-checkout>')
  patchUpstream(process.argv[2])
}

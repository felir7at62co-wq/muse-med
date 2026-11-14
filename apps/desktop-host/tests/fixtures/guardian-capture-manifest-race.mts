import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'guardian-race-')))
const base = fileURLToPath(new URL('../../../..', import.meta.url))
const originalRead = fs.readFile
const manifest = join(root, 'editing', '01-sources.json')
let reads = 0
const sourceA = JSON.stringify({shots:[{shot:1, video:'video/01/shot_001.mp4', audio:'audio-a.wav'}]})
const sourceB = JSON.stringify({shots:[{shot:1, video:'video/01/shot_001.mp4', audio:'audio-b.wav'}]})
fs.readFile = async function(path, ...args) {
  if (typeof path === 'string' && path === manifest ) {
    reads++
    if (reads % 2 === 1) {
      await fs.writeFile(manifest, sourceA)
      const ret = await originalRead.call(this, path, ...args)
      await fs.writeFile(manifest, sourceB)
      return ret
    }
  }
  return await originalRead.call(this, path, ...args)
}
syncBuiltinESMExports()
let provider
try {
  for (const name of ['code','fonts','media','editing','video','video/01']) await fs.mkdir(join(root,name))
  const rows = [['code/index.js','export {}\n'],['fonts/font.ttf','font'],['media/ffmpeg','ffmpeg'],['media/ffprobe','ffprobe'],
    ['project_config.json','{"project_bible":{"visual_medium":"animation_3d"}}'],['editing/01-episode-delivery.json','{"schema_version":1,"episode":1}'],
    ['editing/01-timeline.json', JSON.stringify({clips:[{shot:1,start_us:0,duration_us:1000000}],body_end:1,delivery:{width:1920,height:1080,fps:30,visual_medium:'animation_3d'}})],
    ['editing/01.srt','1\n00:00:00,000 --> 00:00:01,000\n台词\n'],['editing/mix.json','{"schema_version":1,"mode":"no_bgm","analysis_window_ms":50}'],
    ['editing/01-sources.json',sourceB],['video/01/shot_001.mp4','video'],['audio-a.wav','A-audio'],['audio-b.wav','B-audio']]
  await Promise.all(rows.map(([name, content]) => fs.writeFile(join(root,name),content)))
  const { createConfiguredEpisodeRenderer } = await import(pathToFileURL(join(base, 'apps/desktop-host/src/approved-episode-render.ts')).href)
  const { inspectEpisodeFile } = await import(pathToFileURL(join(base, 'apps/desktop-host/src/episode-render-inputs.ts')).href)
  const { episodeFactsHash,parseEpisodeRendererConfig } = await import(pathToFileURL(join(base, 'apps/desktop-host/src/episode-render-descriptor.ts')).href)
  const signal = new AbortController().signal
  const items = [['project','project_config.json'],['plan','editing/01-episode-delivery.json'],['timeline','editing/01-timeline.json'],['subtitle','editing/01.srt'],['mix-profile','editing/mix.json']]
  const inputHashes = await Promise.all(items.map(async ([role, path]) => ({...await inspectEpisodeFile(join(root,path),signal),role})))
  const input = {projectDir:root, episode:1, planPath:join(root,'editing/01-episode-delivery.json'), timelinePath:join(root,'editing/01-timeline.json'), subtitlePath:join(root,'editing/01.srt'), mixProfilePath:join(root,'editing/mix.json'), inputHashes, digest:episodeFactsHash(inputHashes)}
  const rendererConfig = {ffmpegPath:join(root,'media/ffmpeg'), ffprobePath:join(root,'media/ffprobe'), fontsDir:join(root,'fonts'),subtitleFontFamily:'Captured',watermarkFontFamily:'Captured',maxBgmVolume:1,normalizeSubtitleText:true,enforceSubtitleVisual:true,defaultSubtitleVisual:{schema_version:1,reference_width:480,reference_height:854,font_size_px:46,outline_px:1.25,center_y_ratio:0.736747073,max_width_ratio:0.9}}
  const limits = {requestBytes:4096,replyBytes:8192,descriptorBytes:131072,journalBytes:131072,lockWaitMs:1000,mediaGraceMs:100,mediaStdoutBytes:65536,mediaStderrBytes:65536,diagnosticBytes:4096,runtimeEntries:100}
  provider = await createConfiguredEpisodeRenderer({rendererConfig,carrier:{kind:'source-fixture', executable:process.execPath,cli:base+'/apps/cli/src/bin.ts',tsxEsm:base+'/node_modules/tsx/dist/esm/index.mjs',tsconfig:base+'/tsconfig.json',subprocessEntry:join(root,'code/index.js'),workerEntry:join(root,'code/index.js')},codeFiles:[join(root,'code/index.js')],endingAssetRoot:root,limits,resolveExecutable:async command=>command,verifyConfiguration:async()=>{}},signal)
  await assert.rejects(provider.capture(input, signal), /字幕来源清单在读取时发生变化/)
  assert.ok(reads >= 1, 'the manifest must have been read during the race')
  console.log(JSON.stringify({ reads, manifestJSON: JSON.parse(await originalRead.call(fs, manifest, 'utf8')), result: 'rejected-mixed-manifest-and-audio' }))

} finally {
  fs.readFile=originalRead; syncBuiltinESMExports(); await provider?.dispose(); await fs.rm(root,{recursive:true,force:true})
}

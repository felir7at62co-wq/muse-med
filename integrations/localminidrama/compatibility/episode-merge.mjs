/** Replace the pinned companion's capped merge path with complete verified local assembly. */
import {createHash} from 'node:crypto'
import {existsSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'

/**
 * Plan complete episode assembly after the other companion corrections have been staged.
 * @param root - Pinned upstream checkout.
 * @param readSource - Latest staged source, including the original complete-merge correction.
 * @returns The validated wrapper and owned merge implementation without writing files.
 */
export function planEpisodeMerge(root,readSource=path=>readFileSync(path,'utf8')) {
  const file=resolve(root,'backend-node/src/services/videoMergeService.js'),owned=resolve(root,'backend-node/src/services/museEpisodeMerge.js')
  if(existsSync(owned))throw Error('Muse episode merge implementation already exists')
  const source=readSource(file).replaceAll('\r\n','\n'),start=source.indexOf('async function processVideoMerge('),end=source.indexOf('\nmodule.exports',start)
  if(start<0||end<0||createHash('sha256').update(source.slice(start,end)).digest('hex')!=='42252b915eef738134e5db84a01d0656218d02575ecbbdf18770fc6733b2e92e')throw Error('Muse episode merge patch does not match pinned staged source')
  const wrapper='async function processVideoMerge(db, log, mergeId, baseUrl) {\n  return require(\'./museEpisodeMerge\').processVideoMerge(db, log, mergeId, baseUrl);\n}\n'
  return [[file,source.slice(0,start)+wrapper+source.slice(end)],
    [owned,readFileSync(new URL('../extensions/muse-episode-merge.cjs',import.meta.url),'utf8').replaceAll('\r\n','\n')]]
}

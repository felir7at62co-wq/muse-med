/** Exercise the Desktop draft tool with only the external Python/library substituted. */
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const Draft = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/jianying-draft.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/jianying-draft.js', import.meta.url),
)
const CreationPolicy = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/creation-policy.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/creation-policy.js', import.meta.url),
)

export const name = 'snapshot-jianying-draft'
export const inject = ['subprocess', 'tools', 'systemPrompt']

/** Mount the real tool and retain the real managed process provider. */
export async function apply(ctx) {
  const original = ctx.subprocess.spawn.bind(ctx.subprocess)
  const python = `
    const fs = require('node:fs'), path = require('node:path');
    const request = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const target = path.join(process.argv[2], request.name_prefix + String(request.episode).padStart(2, '0'));
    fs.mkdirSync(target); fs.writeFileSync(path.join(target,'draft_content.json'),JSON.stringify({})+String.fromCharCode(10));
    const warnings = ['Subtitle cue 1 needs review; candidate preserved.'];
    const review = path.join(target, 'muse-review.json');
    fs.writeFileSync(review, JSON.stringify({status:'needs_review',warnings})+String.fromCharCode(10));
    console.log(JSON.stringify({success:true,drafts_created:1,drafts:[{episode:'95',name:'candidate-95',path:target,id:'draft-id',success:true,error:'',quality:'needs_review',warnings,review_path:review}],quality:'needs_review',warnings,library:{name:'pyJianYingDraft',version:'0.3.1'},editor_open_verified:false}));
  `
  ctx.effect(() => {
    ctx.subprocess.spawn = spec => spec.argv[2]?.endsWith('generate_draft_request.py')
      ? original({ ...spec, argv: [process.execPath, '-e', python, spec.argv[3], spec.argv[4]] })
      : original(spec)
    return () => { ctx.subprocess.spawn = original }
  })
  ctx.on('agent/created', async ({ agent }) => { await agent.ctx.plugin(CreationPolicy) })
  await ctx.plugin(Draft, { source: process.cwd(), pythonPath: process.execPath,
    timeoutMs: 30000, graceMs: 100, maxInputBytes: 65536, maxOutputBytes: 65536 })
}

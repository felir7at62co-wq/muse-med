/** Model-visible tools for the Jubian drama resource site ("剧壳资源管理系统"). */
import { resolve } from 'node:path'
import { DramaWebClient, RESOURCE_TYPES } from './client.js'

export const name = 'muse-drama-web'

/** Host services this plugin needs: tool registration plus the real initiator's working directory. */
export const inject = ['tools', 'agents']

/**
 * Register the tool surface; loading performs no network request and needs no token.
 * @param {any} ctx - Cordis context.
 * @param {Record<string, any>} config - Plugin config from `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
  const client = new DramaWebClient(config)
  const output = (extra = {}) => ({
    schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, ...extra }, required: ['ok'] },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  })
  const present = (title, kind = 'read') => ({
    presentCall: () => ({ card: 'generic', title, kind }),
    presentResult: (_args, result) => ({ card: 'generic', title, content: result.content }),
  })
  const register = (tool, label) => ctx.effect(() => ctx.tools.register(tool), `drama-web: ${label}`)

  register({
    name: 'drama_web_login',
    description: '用剧壳账号换一个 Bearer token（POST /auth/login，form-urlencoded）。账号密码只从宿主环境变量读取（DRAMA_WEB_USERNAME / DRAMA_WEB_PASSWORD），不接受模型传参，返回里不回显 token。token 只留在本进程内存，进程结束即失效。若已配置 DRAMA_WEB_TOKEN 则无需调用本工具。返回 must_change_password 为真时必须先到网页端改密，否则后续接口继续 401。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: output({ token_present: { type: 'boolean' }, must_change_password: { type: 'boolean' }, expires_at: { type: ['string', 'null'] } }),
    timeoutMs: 35_000,
    execute: async (_args, exec) => {
      const username = process.env[client.config.usernameEnv] ?? ''
      const password = process.env[client.config.passwordEnv] ?? ''
      if (!username || !password) {
        return { ok: false, token_present: false, reason: `host did not provide ${client.config.usernameEnv} / ${client.config.passwordEnv}` }
      }
      const result = await client.login({ username, password }, exec.signal)
      const exp = typeof result.claims?.exp === 'number' ? new Date(result.claims.exp * 1000).toISOString() : null
      return {
        ok: true,
        token_present: true,
        must_change_password: result.mustChangePassword,
        claims: { role: result.claims?.role ?? null, team: result.claims?.team ?? null, sub: result.claims?.sub ?? null },
        expires_at: exp,
      }
    },
    ...present('剧壳登录'),
  }, 'login')

  register({
    name: 'drama_web_library',
    description: '检索剧壳短剧库（GET /dramas）。keyword 是剧名关键词；status / market（domestic 或 overseas）/ push_status 是过滤位；created_from 与 created_to 是创建日期；page 与 page_size 控制分页。返回 items 与 total；total 大于已取条数时说明还有下一页，不要把首页当全量。只读，不产生费用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keyword: { type: 'string', description: '剧名关键词' },
        status: { type: 'string' },
        market: { type: 'string', description: 'domestic 或 overseas' },
        push_status: { type: 'string' },
        created_from: { type: 'string' },
        created_to: { type: 'string' },
        leader_id: { type: 'integer' },
        only_group: { type: 'boolean' },
        page: { type: 'integer' },
        page_size: { type: 'integer' },
      },
    },
    output: output({ total: { type: 'integer' }, count: { type: 'integer' } }),
    timeoutMs: 35_000,
    execute: async (args, exec) => {
      const data = await client.listDramas(args, exec.signal)
      const items = Array.isArray(data?.items) ? data.items : []
      return { ok: true, total: typeof data?.total === 'number' ? data.total : null, count: items.length, items, raw: data }
    },
    ...present('剧壳短剧库'),
  }, 'library')

  register({
    name: 'drama_web_profile',
    description: '读取一部短剧的完整档案（GET /dramas/{id}，可选 siblings）。真实字段包括 title、aliases、cover_url、episode_count、paid_episode、drama_type、market、age_group、status、staff、title_tags、ai_generated、file_counts、total_duration。集数与别名一律以返回为准，不要按剧名推断。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { dramaId: { type: 'integer' }, includeSiblings: { type: 'boolean' } },
      required: ['dramaId'],
    },
    output: output(),
    timeoutMs: 35_000,
    execute: async (args, exec) => {
      const drama = await client.getDrama(args.dramaId, exec.signal)
      const siblings = args.includeSiblings ? await client.siblings(args.dramaId, exec.signal) : null
      return { ok: true, drama, siblings, page: client.mintUrl(args.dramaId) }
    },
    ...present('剧壳剧目档案'),
  }, 'profile')

  register({
    name: 'drama_web_files',
    description: `列出剧目资源文件（GET /dramas/{id}/files）。resource_type 只接受剧壳自己的分类：${RESOURCE_TYPES.join(' / ')}。variant 用于区分同类的多个版本。返回的文件 id 是取下载地址和做网盘分享的唯一凭据，不要用文件名代替。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dramaId: { type: 'integer' },
        resource_type: { type: 'string', enum: RESOURCE_TYPES },
        variant: { type: 'string' },
      },
      required: ['dramaId'],
    },
    output: output({ count: { type: 'integer' } }),
    timeoutMs: 35_000,
    execute: async (args, exec) => {
      const data = await client.listFiles(args.dramaId, { resourceType: args.resource_type, variant: args.variant }, exec.signal)
      const list = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : null)
      return { ok: true, count: list ? list.length : null, files: data }
    },
    ...present('剧壳文件清单'),
  }, 'files')

  register({
    name: 'drama_web_download',
    description: '把单个文件从剧壳下载到当前工作区（先 GET /files/{id}/url 取签名地址，再下载）。落盘后核对字节数与 SHA-256，并在结果里给出回执。签名地址有时效，不能缓存或复用；批量下载请先取文件清单再逐个调用。省略 outputPath 时只返回地址、不落盘。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fileId: { type: 'integer' },
        outputPath: { type: 'string', description: '相对当前工作区的落盘路径' },
      },
      required: ['fileId'],
    },
    output: output({ bytes: { type: 'integer' }, sha256: { type: 'string' }, path: { type: 'string' } }),
    timeoutMs: 600_000,
    execute: async (args, exec) => {
      if (!args.outputPath) {
        const signed = await client.fileUrl(args.fileId, 'attachment', exec.signal)
        return { ok: true, url: signed?.url ?? signed?.download_url ?? null, raw: signed }
      }
      const cwd = ctx.agents.requireInitiator().session.header.cwd
      const receipt = await client.download(args.fileId, resolve(cwd, args.outputPath), { signal: exec.signal })
      return { ok: true, ...receipt }
    },
    ...present('剧壳文件下载', 'write'),
  }, 'download')

  register({
    name: 'drama_web_pan_share',
    description: '生成或读取网盘分享。action=create 时向 POST /dramas/{id}/pan-share 提交 {period_days, file_ids, remark}；这是异步任务，返回 message 只代表受理，必须再用 action=tasks 复查才算完成。action=list 读已有分享，action=tasks 读生成任务。file_ids 必须来自 drama_web_files 的真实 id。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dramaId: { type: 'integer' },
        action: { type: 'string', enum: ['list', 'tasks', 'create'] },
        period_days: { type: 'integer', description: '分享有效期，默认 7 天' },
        file_ids: { type: 'array', items: { type: 'integer' } },
        remark: { type: 'string' },
      },
      required: ['dramaId', 'action'],
    },
    output: output({ accepted: { type: 'boolean' } }),
    timeoutMs: 60_000,
    execute: async (args, exec) => {
      if (args.action === 'list') return { ok: true, shares: await client.listPanShares(args.dramaId, exec.signal) }
      if (args.action === 'tasks') return { ok: true, tasks: await client.panShareTasks(args.dramaId, exec.signal) }
      if (!Array.isArray(args.file_ids) || args.file_ids.length === 0) return { ok: false, accepted: false, reason: 'create needs at least one real file_ids entry' }
      const created = await client.createPanShare(args.dramaId, {
        period_days: args.period_days ?? 7,
        file_ids: args.file_ids,
        remark: args.remark ?? '',
      }, exec.signal)
      return { ok: true, accepted: true, created, next: 'call action=tasks to confirm generation' }
    },
    ...present('剧壳网盘分享', 'write'),
  }, 'pan-share')

  register({
    name: 'drama_web_title',
    description: '调用剧壳服务端的模型端点：action=title 走 POST /dramas/{id}/generate-title，action=analyze 走 POST /dramas/{id}/analyze-script。两者无请求体、上游允许 320 秒，本工具给 330 秒。结果只作草稿，改写剧名要走网页端或专门的写入流程，不要直接覆盖。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { dramaId: { type: 'integer' }, action: { type: 'string', enum: ['title', 'analyze'] } },
      required: ['dramaId', 'action'],
    },
    output: output({ action: { type: 'string' } }),
    timeoutMs: 340_000,
    execute: async (args, exec) => {
      const started = Date.now()
      const data = args.action === 'analyze'
        ? await client.analyzeScript(args.dramaId, exec.signal)
        : await client.generateTitle(args.dramaId, exec.signal)
      return { ok: true, action: args.action, elapsedMs: Date.now() - started, data }
    },
    ...present('剧壳标题/剧本解析', 'write'),
  }, 'title')

  register({
    name: 'drama_web_subtitle_erase',
    description: '提交或读取去字幕任务。action=create 需要真实测得的画面区域：source_file_id、left、top、width、height、video_width、video_height、duration；坐标必须与源视频分辨率同源，猜坐标会得到废片。提交前会先读 /subtitle-erase/enabled，服务端未开启则直接返回。action=list 只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dramaId: { type: 'integer' },
        action: { type: 'string', enum: ['list', 'create'] },
        source_file_id: { type: 'integer' },
        left: { type: 'integer' },
        top: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        video_width: { type: 'integer' },
        video_height: { type: 'integer' },
        duration: { type: 'integer' },
      },
      required: ['dramaId', 'action'],
    },
    output: output(),
    timeoutMs: 65_000,
    execute: async (args, exec) => {
      if (args.action === 'list') return { ok: true, tasks: await client.subtitleEraseTasks(args.dramaId, exec.signal) }
      const enabled = await client.subtitleEraseEnabled(exec.signal)
      if (enabled && enabled.enabled === false) return { ok: false, reason: 'subtitle erasure is disabled on this deployment' }
      const body = {
        source_file_id: args.source_file_id,
        left: args.left,
        top: args.top,
        width: args.width,
        height: args.height,
        video_width: args.video_width,
        video_height: args.video_height,
        duration: args.duration,
      }
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined || value === null) return { ok: false, reason: `create is missing ${key}` }
      }
      return { ok: true, task: await client.createSubtitleEraseTask(args.dramaId, body, exec.signal) }
    },
    ...present('剧壳去字幕', 'write'),
  }, 'subtitle-erase')

  register({
    name: 'drama_web_link',
    description: '把一个剧目 id 拼成剧壳页面地址（不发请求）。把结果回给用户时用它给出可人工复核的入口。',
    parameters: { type: 'object', additionalProperties: false, properties: { dramaId: { type: 'integer' } }, required: ['dramaId'] },
    output: output({ url: { type: 'string' } }),
    timeoutMs: 5_000,
    execute: async args => ({ ok: true, url: client.mintUrl(args.dramaId) }),
    ...present('剧壳入口'),
  }, 'link')
}

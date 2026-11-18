/** Brand the pinned studio as Muse while retaining provider setup and legal notices. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Static promotional assets removed only after the patch transaction validates their pinned bytes. */
export const museBrandingRemovals = Object.freeze([
  Object.freeze({ path: 'frontweb/public/wx.jpg', sha256: '1636ad9a5f4f57b83f6e77595d52b0e0670848e275697777718f1bdc0b33531f' }),
])

function replace(source, before, after, file, count = 1) {
  if (source.split(before).length - 1 !== count) {
    throw new Error(`Muse branding patch does not match pinned source: ${file}`)
  }
  return source.replaceAll(before, after)
}

function removeSection(source, start, end, sha256, file) {
  const from = source.indexOf(start), to = source.indexOf(end, from)
  if (from < 0 || to < 0 || from !== source.lastIndexOf(start)
    || createHash('sha256').update(source.slice(from, to)).digest('hex') !== sha256) {
    throw new Error(`Muse branding patch does not match pinned source: ${file}`)
  }
  return source.slice(0, from) + source.slice(to)
}

/**
 * Plan Muse titles and remove author contact and sales promotion without changing generation settings.
 * @param root - Checkout of the pinned upstream revision.
 * @param readSource - Latest staged source at an absolute path.
 * @returns Complete text replacements; the patch owner separately validates and removes `museBrandingRemovals`.
 */
export function planMuseBranding(root, readSource = path => readFileSync(path, 'utf8')) {
  const pending = []
  const patch = (file, transform) => {
    const path = resolve(root, file)
    pending.push([path, transform(readSource(path).replaceAll('\r\n', '\n'), file)])
  }
  patch('frontweb/index.html', (source, file) => replace(source,
    '<title>本地短剧助手 - AI 短剧生成工具</title>', '<title>Muse · 制作平台</title>', file))
  patch('frontweb/src/router/index.js', (source, file) => replace(source,
    'document.title = `${to.meta.title} - LocalMiniDrama`', 'document.title = `${to.meta.title} - Muse`', file))

  for (const view of ['AiConfig', 'DramaDetail', 'FilmCreate', 'FilmList', 'DramaCanvas']) {
    patch(`frontweb/src/views/${view}.vue`, (source, file) => {
      source = replace(source, '<span class="logo-main">本地短剧助手</span>', '<span class="logo-main">Muse</span>', file)
      if (view !== 'DramaCanvas') source = replace(source,
        '<span class="logo-sub">LocalMiniDrama</span>', '<span class="logo-sub">制作平台</span>', file)
      if (view === 'FilmCreate') source = replace(source, '低价 Seedance2', 'Seedance2（Sora 兼容）', file, 2)
      if (view !== 'FilmList') return source
      source = replace(source, `          <el-button v-if="!vendorLockEnabled" class="btn-wechat" title="扫码联系作者" @click="showWechat = true">
            <el-icon><ChatDotSquare /></el-icon>微信我
          </el-button>
`, '', file)
      source = removeSection(source, '    <!-- 微信二维码 -->\n', '    <!-- 图片放大预览 -->',
        'f9f4cae87aa3b7e9e26a783d191e65b58edf6fa1c4661eb18b89f6bf915cd239', file)
      source = removeSection(source, '/* 微信我按钮 —— 绿调 */\n', '/* AI配置按钮 —— 琥珀调 */',
        '0dcb88931f3b08aed78da8c28e12925bedcf0830c1fcf913c890dc7d460fdd2d', file)
      source = replace(source, 'Moon, ChatDotSquare, Download', 'Moon, Download', file)
      source = replace(source, "import { aiAPI } from '@/api/ai'\n", '', file)
      source = replace(source, 'const showWechat = ref(false)\nconst vendorLockEnabled = ref(false)\n', '', file)
      return replace(source, `  try {
    const lock = await aiAPI.getVendorLock()
    vendorLockEnabled.value = !!lock?.enabled
  } catch (_) {}
`, '', file)
    })
  }

  patch('frontweb/src/components/AIConfigContent.vue', (source, file) => {
    source = removeSection(source, '        <el-alert\n          v-if="form.provider === \'cheap_seedance2\'"', '        <!-- 接口规范：',
      'db112bcac684abe2f48b924eabd95b0a73a9210447936c51d6a7e5311a260b6d', file)
    source = removeSection(source, '.cheap-seedance2-tip {\n', '.protocol-help .ph-body {',
      'a3ee6d852386391264eca30577a94ff986218a65a15330029e03492da0cfdde6', file)
    source = replace(source, '                <span class="one-key-not-recommended">不推荐</span>\n', '', file)
    source = removeSection(source, '.one-key-not-recommended {\n', '.one-key-help {',
      '27b44fd8115fa8cc13964f3cc92d89e794b51a30fc08ecc6ce3d28eac8ac86a2', file)
    source = replace(source, '                    <b>推荐</b>：通义千问 / 火山引擎，国内访问稳定。\n', '', file)
    source = replace(source, '一键配置通义千问 / 万象（不推荐）', '一键配置通义千问 / 万象', file)
    source = replace(source, '                  <b>适用场景：</b>练手、流水剧制作；按次计费（约 1 元/次），不按秒计费。<br>\n', '', file)
    source = replace(source, '                  <b>官网 / 充值：</b><a href="https://workbench.ohmybb.xyz/" target="_blank" rel="noopener noreferrer">https://workbench.ohmybb.xyz/</a>\n', '', file)
    source = replace(source, '            <li>打开官网：<a href="https://workbench.ohmybb.xyz/" target="_blank" rel="noopener noreferrer" class="one-key-link">workbench.ohmybb.xyz</a></li>\n', '', file)
    source = replace(source, '注册/登录阿里云账号，开通「百炼」服务（新用户有免费额度）', '注册/登录阿里云账号，开通「百炼」服务', file)
    source = replace(source, '注册/登录字节跳动火山引擎账号（新用户有免费 token 额度）', '注册/登录字节跳动火山引擎账号', file)
    return replace(source, '低价 Seedance2', 'Seedance2（Sora 兼容）', file, 11)
  })
  return pending
}

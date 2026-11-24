/** Keep project entry actions compact and failed saves and media queries visible. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function replace(source, before, after, file) {
  if (source.split(before).length !== 2) throw Error('Muse studio entry patch does not match pinned source: ' + file)
  return source.replace(before, after)
}

/**
 * Prepare project navigation and bounded media loading after existing studio patches.
 * @param {string} root Pinned upstream checkout.
 * @param {(path: string) => string} readSource Source including earlier planners.
 * @returns {Array<[string, string]>} Validated source replacements.
 */
export function planStudioEntry(root, readSource = path => readFileSync(path, 'utf8')) {
  const out = []
  const css = readFileSync(new URL('../extensions/muse-studio-entry.css', import.meta.url), 'utf8')
  const patch = (name, transform) => {
    const file = resolve(root, 'frontweb/src/views', name + '.vue')
    let source = readSource(file).replaceAll('\r\n', '\n')
    source = transform(source, file)
    source = replace(source, '<style scoped>', '<style scoped>\n' + css, file)
    out.push([file, source])
  }
  patch('FilmList', (source, file) => {
    const start = source.indexOf('    <header class="header">'), end = source.indexOf('    </header>', start) + '    </header>'.length
    const header = source.slice(start, end)
    if (start < 0 || end < 0 || createHash('sha256').update(header).digest('hex') !== 'f8f204d9046be92c5a54940d8507be18928743df394a68d1d3eb41cfca20ee5e') throw Error('Muse project header does not match pinned source')
    source = replace(source, header, readFileSync(new URL('../extensions/muse-project-header.html', import.meta.url), 'utf8').trimEnd(), file)
    source = replace(source, 'Moon, Download', 'Moon, ArrowDown, Download', file)
    source = replace(source, '    <main class="main">', '    <main class="main">\n      <el-alert v-if="museListError" class="muse-entry-error" :title="museListError" type="error" :closable="false" show-icon><el-button text @click="loadList">重新加载</el-button></el-alert>', file)
    source = replace(source, '<div class="project-card action-card">', '<div v-if="!dramas.length && !loading && !museListError" class="project-card action-card">', file)
    source = replace(source, '            @click="openProject(d.id)"', '            role="link" tabindex="0" @keydown.enter.self="openProject(d.id)"\n            @click="openProject(d.id)"', file)
    source = replace(source, "  router.push('/drama/' + id)", "  router.push('/film/' + id)", file)
    source = replace(source, 'function loadList() {', "const museListError = ref('')\nfunction museProjectCommand(command) {\n  const actions = { characters: () => { showCharLibrary.value = true }, scenes: () => { showSceneLibrary.value = true }, props: () => { showPropLibrary.value = true }, media: () => router.push('/media-library'), import: triggerImport, connection: () => { museLibTvVisible.value = true }, models: () => { showAiConfigDialog.value = true }, theme: toggleTheme }\n  actions[command]?.()\n}\n\nfunction loadList() {", file)
    source = replace(source, '      dramas.value = res?.items ?? []', "      museListError.value = ''\n      dramas.value = res?.items ?? []", file)
    return replace(source, '    .catch(() => {\n      dramas.value = []\n    })', "    .catch(() => {\n      museListError.value = '项目加载失败，保留上次结果。请重新加载。'\n    })", file)
  })
  patch('DramaDetail', (source, file) => {
    source = replace(source, '      <!-- 基本信息 + 设置 -->\n      <section', '      <!-- 基本信息 + 设置 -->\n      <el-alert v-if="museInfoSaveError" class="muse-entry-error" :title="museInfoSaveError" type="error" :closable="false" show-icon><el-button text @click="saveInfo">重试保存</el-button></el-alert>\n      <details class="muse-project-settings"><summary>项目信息与画面设置</summary>\n      <section', file)
    source = replace(source, '      <!-- 分集列表 -->', '      </details>\n\n      <!-- 分集列表 -->', file)
    source = replace(source, '<span class="res-tab-group-label">资源库</span>', '<span class="res-tab-group-label">已加入本剧的素材</span>', file)
    source = replace(source, '<span class="res-tab-group-label res-tab-group-label--prod">制作资源</span>', '<span class="res-tab-group-label res-tab-group-label--prod">剧本中的主体</span>', file)
    source = replace(source, 'let infoSaveTimer = null', "const museInfoSaveError = ref('')\nlet infoSaveTimer = null", file)
    source = replace(source, "      console.error('saveInfo failed', e)", "      museInfoSaveError.value = '项目信息未全部保存，请重试；你的填写仍保留在页面中。'", file)
    return replace(source, "          aspect_ratio: infoForm.aspect_ratio || '16:9',\n        },\n      })\n    } catch", "          aspect_ratio: infoForm.aspect_ratio || '16:9',\n        },\n      })\n      museInfoSaveError.value = ''\n    } catch", file)
  })
  patch('MediaLibrary', (source, file) => {
    source = replace(source, "import { ref, onMounted, reactive } from 'vue'", "import { ref, onMounted, onUnmounted, reactive } from 'vue'", file)
    source = replace(source, 'accept="image/*,video/*"', 'accept="image/jpeg,image/png,image/gif,image/webp"', file)
    source = replace(source, '          上传素材\n', '          上传图片\n', file)
    source = replace(source, '    <!-- 媒体网格 -->', '    <el-alert v-if="museMediaError" class="muse-entry-error" :title="museMediaError" type="error" :closable="false" show-icon><el-button text @click="loadMedia">重新加载</el-button></el-alert>\n\n    <!-- 媒体网格 -->', file)
    source = replace(source, '!loading && mediaItems.length === 0', '!loading && !museMediaError && mediaItems.length === 0', file)
    source = replace(source, 'let keywordTimer = null', "const museMediaError = ref('')\nlet museMediaRequest = 0\nlet keywordTimer = null\nonUnmounted(() => { clearTimeout(keywordTimer); museMediaRequest++ })", file)
    source = replace(source, '  for (const file of files) {', '  let uploaded = 0\n  let unconfirmed = 0\n  for (const file of files) {\n    let registering = false', file)
    source = replace(source, '      await uploadAPI.uploadImage(file)', "      const result = await uploadAPI.uploadImage(file)\n      if (!result?.url) throw new Error('服务器未返回图片地址')\n      registering = true\n      const item = await request.post('/assets', { name: file.name, type: 'image', url: result.url, local_path: result.local_path, file_size: file.size, mime_type: file.type })\n      if (!Number.isSafeInteger(Number(item?.id)) || Number(item.id) <= 0) throw new Error('服务器未返回素材记录')", file)
    source = replace(source, '      uploadProgress.value.current++', '      uploaded++', file)
    source = replace(source, "      ElMessage.warning(`${file.name} 上传失败: ${err.message}`)\n    }", "      if (registering) {\n        unconfirmed++\n        museMediaError.value = `${file.name} 已上传，但未确认加入素材库。请先重新加载核对，避免重复上传。`\n      } else ElMessage.warning(`${file.name} 上传失败: ${err.message}`)\n    } finally {\n      uploadProgress.value.current++\n    }", file)
    source = replace(source, '  ElMessage.success(`${files.length} 个素材上传完成`)', "  if (uploaded) ElMessage.success(`${uploaded} 个图片上传完成`)\n  const failed = files.length - uploaded - unconfirmed\n  if (failed) ElMessage.warning(`${failed} 个文件未上传，请重试失败的文件`)", file)
    source = replace(source, "  loadMedia()\n}\n\nfunction debouncedLoad()", "  if (!unconfirmed) loadMedia()\n}\n\nfunction debouncedLoad()", file)
    source = replace(source, 'async function loadMedia() {\n  loading.value = true', 'async function loadMedia() {\n  const requestId = ++museMediaRequest\n  loading.value = true', file)
    source = replace(source, "    const res = await request.get('/assets', { params })\n    mediaItems.value", "    const res = await request.get('/assets', { params })\n    if (requestId !== museMediaRequest) return\n    museMediaError.value = ''\n    mediaItems.value", file)
    return replace(source, '  } catch (err) {\n    mediaItems.value = []\n  } finally {\n    loading.value = false\n  }', "  } catch (err) {\n    if (requestId === museMediaRequest) museMediaError.value = '素材加载失败，当前保留上次结果。请重新加载。'\n  } finally {\n    if (requestId === museMediaRequest) loading.value = false\n  }", file)
  })
  return out
}

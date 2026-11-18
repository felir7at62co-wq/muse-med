/** Install the Muse gallery workbench while retaining the existing advanced editor. */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Add the owned workbench after the functional compatibility planners.
 * @param root - Exact upstream checkout selected by the integration.
 * @param readSource - Read the accumulated planner output.
 * @returns Validated file replacements; no project or supplier operation is dispatched.
 */
export function planStudioUx(root, readSource = file => readFileSync(file, 'utf8')) {
  const changes = []
  for (const [owned, destination] of [
    ['muse-studio-workbench.vue', 'frontweb/src/views/MuseStudioWorkbench.vue'],
    ['muse-studio-workbench-prompt.vue', 'frontweb/src/components/MuseStudioPrompt.vue'],
    ['muse-studio-workbench.js', 'frontweb/src/utils/museStudioWorkbench.js'],
    ['muse-studio-workbench.css', 'frontweb/src/styles/museStudioWorkbench.css'],
  ]) {
    const target = resolve(root, destination)
    if (existsSync(target)) throw new Error('Muse workbench owned file already exists: ' + destination)
    changes.push([target, readFileSync(new URL('../extensions/' + owned, import.meta.url), 'utf8').replaceAll('\r\n', '\n')])
  }
  const file = resolve(root, 'frontweb/src/router/index.js')
  const source = readSource(file).replaceAll('\r\n', '\n')
  const before = `      path: '/film/:id',
      name: 'film',
      component: () => import('@/views/FilmCreate.vue'),
      meta: { title: 'AI 视频生成' }`
  if (source.split(before).length !== 2 || source.includes("name: 'film-advanced'")) {
    throw new Error('Muse workbench route does not match the pinned source')
  }
  changes.push([file, source.replace(before, `      path: '/film/:id',
      name: 'film',
      component: () => import('@/views/MuseStudioWorkbench.vue'),
      meta: { title: '制作工作台' }
    },
    {
      path: '/film/:id/advanced',
      name: 'film-advanced',
      component: () => import('@/views/FilmCreate.vue'),
      meta: { title: '高级制作' }`)])
  return changes
}

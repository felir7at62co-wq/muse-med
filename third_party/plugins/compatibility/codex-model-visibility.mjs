/** Keep subscription models account-authorized and picker menus opaque in private staging. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Patch private build staging without modifying the retained upstream snapshot.
 * @param directory - Staged community package root.
 */
export function applyCodexModelVisibility(directory) {
  const stylesPath = join(directory, 'src/client-styles.js')
  let styles = readFileSync(stylesPath, 'utf8')
  for (const selector of ['.codexModelSelectMenu,.codexModelSelectSubmenu', '.codexModelSelectGroupTitle']) {
    const prefix = `${selector}{`
    if (styles.split(prefix).length !== 2) throw new Error(`Codex model menu needs source review: ${selector}`)
    const start = styles.indexOf(prefix)
    const end = styles.indexOf('}', start)
    const rule = styles.slice(start, end + 1)
    const background = 'background:var(--dsw-specific-menu);'
    if (end === -1 || rule.split(background).length !== 2) throw new Error(`Codex model menu needs source review: ${selector}`)
    styles = styles.slice(0, start) + rule.replace(background, 'background:var(--dsw-alias-bg-base);') + styles.slice(end + 1)
  }
  if (!styles.endsWith('`\n')) throw new Error('Codex model menu stylesheet needs source review')
  styles = styles.slice(0, -2) + `
.codexModelSelectMenu{position:fixed;right:auto;bottom:auto;display:flex;flex-direction:column;overflow:hidden;max-height:min(360px,calc(100vh - var(--dsh-frame-top-clearance,0px) - 36px))}
.codexModelSelectSubmenu{position:static;right:auto;bottom:auto;display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;width:100%;max-width:none;max-height:none;padding:0;border:0;border-radius:0;box-shadow:none}
.codexModelSelectGroups{flex:1;min-height:0;max-height:none}
.codexModelSelectBack{flex:none}
` + '`\n'
  const patches = {
    'src/client-model-select.jsx': [[
      "import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'",
      "import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'\nimport { createPortal } from 'react-dom'\nimport { MenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'",
    ], [
      "import { IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14 } from './client-primitives.js'",
      "import { IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14, IconChevronLeftOutline14, useAnchoredPosition, useDismissOnOutsidePointer } from './client-primitives.js'",
    ], [
      '  const triggerRef = useRef(null)',
      `  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const menuPosition = useAnchoredPosition({ open, anchorRef: triggerRef, panelRef: menuRef, side: 'top', align: 'end', gap: 8, margin: 16 })
  useDismissOnOutsidePointer(rootRef, open, setOpen, menuRef)
  useLayoutEffect(() => {
    if (!open || menuPosition === null || menuRef.current?.contains(document.activeElement)) return
    const target = menuRef.current?.querySelector('[aria-checked="true"]:not(:disabled)')
      ?? menuRef.current?.querySelector('button:not(:disabled)')
    target?.focus()
  }, [open, pane, menuPosition])`,
    ], [
      `  useEffect(() => {
    if (!open) return undefined
    const closeOutside = event => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false)
        setPane('root')
      }
    }
    document.addEventListener('mousedown', closeOutside)
    return () => document.removeEventListener('mousedown', closeOutside)
  }, [open])`,
      `  useEffect(() => {
    if (!open) setPane('root')
  }, [open])`,
    ], [
      '    {open ? <div className="codexModelSelectMenu" id={`${id}-menu`} role="menu" aria-label={t(\'modelMenuAria\')} aria-busy={state.status === \'loading\' || busy}>',
      '    {open ? createPortal(<MenuSurface opaque ref={menuRef} className="codexModelSelectMenu" style={menuPosition ?? { visibility: \'hidden\', left: 0, top: 0 }} id={`${id}-menu`} role="menu" aria-label={t(\'modelMenuAria\')} aria-busy={state.status === \'loading\' || busy}>\n      {pane === \'root\' ? <>',
    ], [
      `      {submenu}
    </div> : null}`,
      `      </> : <>
        <button type="button" role="menuitem" className="codexModelSelectCell codexModelSelectBack" onClick={() => setPane('root')}>
          <IconChevronLeftOutline14 className="codexModelSelectCellChevron" />
          <span className="codexModelSelectCellLabel">{t('modelBack')}</span>
        </button>
        {submenu}
      </>}
    </MenuSurface>, document.body) : null}`,
    ]],
    'src/client-locales.js': [[
      "  modelMenuAria: '模型、推理等级、速度与输出详略',",
      "  modelBack: '返回', modelMenuAria: '模型、推理等级、速度与输出详略',",
    ], [
      "  modelMenuAria: 'Model, effort, speed, and output detail',",
      "  modelBack: 'Back', modelMenuAria: 'Model, effort, speed, and output detail',",
    ]],
    'src/index.js': [[
      'const adapter = new PiAiAdapter({',
      `const adapter = new class extends PiAiAdapter {
    async listModels(provider) {
      const credential = await store.read(provider)
      return credential?.type === 'oauth' ? super.listModels(provider) : []
    }
  }({`,
    ]],
    'tests/plugin-integration.test.mjs': [[
      `test('every advertised Codex model resolves and prepares without reading credentials', async () => {
  const host = fakeContext()
  applyPlugin(host.ctx)
  // Activation may inspect account state; model metadata must not require it.
  host.ctx.credentials.resolve = async () => assert.fail('model metadata must not read credentials')
  const adapter = host.registered[0].adapter
  const models = await adapter.listModels('openai-codex')
  assert.ok(models.length > 0)`,
      `test('Codex models appear only while a subscription account is connected', async () => {
  const host = fakeContext()
  applyPlugin(host.ctx)
  const adapter = host.registered[0].adapter
  assert.deepEqual(await adapter.listModels('openai-codex'), [])
  await host.ctx.credentials.set(undefined, JSON.stringify({ type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000 }))
  const models = await adapter.listModels('openai-codex')
  assert.ok(models.length > 0)
  await host.ctx.credentials.unset()
  assert.deepEqual(await adapter.listModels('openai-codex'), [])`,
    ], [
      "assert.ok(models.length > 0, 'the supported DSH adapter must receive auth before creating its model registry')",
      "assert.deepEqual(models, [], 'an unconnected subscription must not advertise selectable models')",
    ]],
  }
  for (const [file, replacements] of Object.entries(patches)) {
    const path = join(directory, file)
    let source = readFileSync(path, 'utf8')
    for (const [before, after] of replacements) {
      if (source.split(before).length !== 2) throw new Error(`Codex model visibility needs source review: ${file}`)
      source = source.replace(before, after)
    }
    writeFileSync(path, source)
  }
  writeFileSync(stylesPath, styles)
}

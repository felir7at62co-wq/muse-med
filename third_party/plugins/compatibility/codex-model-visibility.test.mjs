/** Private staging keeps Codex account discovery and opaque picker surfaces separate from retained files. */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyCodexModelVisibility } from './codex-model-visibility.mjs'

const retained = join(import.meta.dirname, '../dsh-codex-subscription')
const styleFile = 'src/client-styles.js'
const selectors = ['.codexModelSelectMenu,.codexModelSelectSubmenu', '.codexModelSelectGroupTitle']

test('makes the picker opaque and viewport-anchored while retaining selection actions and upstream files', () => {
  const original = readFileSync(join(retained, styleFile), 'utf8')
  const selectorSource = readFileSync(join(retained, 'src/client-model-select.jsx'), 'utf8')
  const root = mkdtempSync(join(tmpdir(), 'muse-codex-menu-'))
  try {
    cpSync(retained, root, { recursive: true })
    applyCodexModelVisibility(root)
    const staged = readFileSync(join(root, styleFile), 'utf8')
    for (const selector of selectors) {
      const rule = staged.slice(staged.indexOf(`${selector}{`)).split('}')[0]
      assert.match(rule, /background:var\(--dsw-alias-bg-base\);/)
      assert.doesNotMatch(rule, /--dsw-specific-menu|backdrop-filter/)
    }
    const originalStyles = staged.slice(0, staged.indexOf('\n.codexModelSelectMenu{position:fixed')) + '`\n'
    assert.equal(originalStyles.replaceAll('background:var(--dsw-alias-bg-base);', 'background:var(--dsw-specific-menu);'), original)
    assert.match(staged, /\.codexModelSelectSubmenu\{position:static;/)
    assert.match(staged, /\.codexModelSelectGroups\{flex:1;min-height:0;max-height:none\}/)
    const selector = readFileSync(join(root, 'src/client-model-select.jsx'), 'utf8')
    const actions = text => text.slice(text.indexOf('  const close ='), text.indexOf('  let submenu ='))
    assert.equal(actions(selector), actions(selectorSource))
    assert.match(selector, /useDismissOnOutsidePointer\(rootRef, open, setOpen, menuRef\)/)
    assert.match(selector, /useAnchoredPosition\(\{ open, anchorRef: triggerRef, panelRef: menuRef, side: 'top', align: 'end'/)
    assert.match(selector, /createPortal\(<MenuSurface opaque ref=\{menuRef\}/)
    assert.match(selector, /<\/MenuSurface>, document\.body\)/)
    assert.match(selector, /t\('modelBack'\)/)
    assert.match(selector, /if \(pane === 'root'\) close\(true\)/)
    assert.match(selector, /menuRef\.current\?\.contains\(document\.activeElement\)/)
    assert.match(selector, /target\?\.focus\(\)/)
    assert.equal(readFileSync(join(retained, 'src/client-model-select.jsx'), 'utf8'), selectorSource)
    const locales = readFileSync(join(root, 'src/client-locales.js'), 'utf8')
    assert.match(locales, /modelBack: '返回'/)
    assert.match(locales, /modelBack: 'Back'/)
    assert.match(readFileSync(join(root, 'src/index.js'), 'utf8'), /credential\?\.type === 'oauth' \? super\.listModels\(provider\) : \[\]/)
    assert.equal(readFileSync(join(retained, styleFile), 'utf8'), original)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const change of ['selector', 'background']) {
  test(`rejects an unreviewed menu ${change} before changing staged provider or styles`, () => {
    const root = mkdtempSync(join(tmpdir(), 'muse-codex-menu-review-'))
    try {
      cpSync(retained, root, { recursive: true })
      const stylesPath = join(root, styleFile)
      const source = readFileSync(stylesPath, 'utf8')
      const prefix = '.codexModelSelectGroupTitle{'
      const modified = change === 'selector' ? source.replace(prefix, '.unreviewedTitle{')
        : source.replace(`${prefix}position:sticky;top:0;z-index:1;padding:5px 8px 3px;background:var(--dsw-specific-menu);`,
          `${prefix}position:sticky;top:0;z-index:1;padding:5px 8px 3px;background:transparent;`)
      assert.notEqual(modified, source)
      writeFileSync(stylesPath, modified)
      const provider = readFileSync(join(root, 'src/index.js'), 'utf8')
      assert.throws(() => applyCodexModelVisibility(root), /Codex model menu needs source review/)
      assert.equal(readFileSync(stylesPath, 'utf8'), modified)
      assert.equal(readFileSync(join(root, 'src/index.js'), 'utf8'), provider)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

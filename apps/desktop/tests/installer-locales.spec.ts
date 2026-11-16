import { SHIPPED_LOCALE_IDS } from '../../../scripts/shipped-locales.ts'
import { createRequire } from 'node:module'
/** Per-language installer resources feed both the packaging language list and the NSIS compiler. */
import { globSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { readInstallerLocales, renderInstallerStrings } from '../scripts/installer-locales.mjs'

const require = createRequire(import.meta.url)
const { LangConfigurator, createAddLangsMacro } = require('app-builder-lib/out/targets/nsis/nsisLang.js') as {
  LangConfigurator: new (options: { installerLanguages: string[] }) => object
  createAddLangsMacro: (generator: { macro: (name: string, lines: string[]) => void }, languages: object) => void
}

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-installer-locales-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  for (const id of ['en_US', 'zh_CN', 'ja_JP', 'es_ES', 'fr_FR', 'de_DE', 'ru_RU', 'pt_BR']) {
    writeFileSync(join(directory, `${id}.json`), readFileSync(new URL(`../installer/locales/${id}.json`, import.meta.url)))
  }
  return directory
}

it('declares every NSIS installer string for every shipped language', () => {
  const directory = fileURLToPath(new URL('../installer/', import.meta.url))
  const sources = readdirSync(directory).filter(name => name.endsWith('.nsh'))
    .map(name => readFileSync(join(directory, name), 'utf8'))
  sources.push(readFileSync(new URL('../scripts/installer.nsh', import.meta.url), 'utf8'))
  const required = new Set(sources.flatMap(source => [...source.matchAll(/\$\((INSTALLER_[A-Z_]+)\)/gu)].map(match => match[1]!)))
  expect(required.size).toBeGreaterThan(0)
  for (const locale of readInstallerLocales()) {
    for (const key of required) expect(locale.strings, `${locale.id}: ${key}`).toHaveProperty(key)
  }
})

it('generates Japanese NSIS strings from the same files that select packaged languages', () => {
  const locales = readInstallerLocales()
  expect(locales.map(locale => locale.id)).toEqual(['en_US', 'de_DE', 'es_ES', 'fr_FR', 'ja_JP', 'pt_BR', 'ru_RU', 'zh_CN'])
  const source = renderInstallerStrings(locales)
  expect(source).toContain('LangString INSTALLER_INSTALL ${LANG_JAPANESE} "今すぐインストール"')
  expect(source).toContain('LangString INSTALLER_NATIVE_PROGRESS ${LANG_JAPANESE} "インストールを準備しています… %d%%"')
  expect(source).toContain('!ifdef LANG_JAPANESE\n')
  expect(source.match(/^LangString /gmu)).toHaveLength(312)
  const japanese = locales.filter(locale => locale.id === 'ja_JP')
  expect(renderInstallerStrings(japanese)).not.toContain('${LANG_ENGLISH}')
})

it('declares every product NSIS string reference in each generated installer language', () => {
  const appRoot = fileURLToPath(new URL('../', import.meta.url))
  const files = globSync(['installer/**/*.nsh', 'scripts/installer*.nsh'], { cwd: appRoot })
  expect(files.length).toBeGreaterThan(0)
  const keys = [...new Set(files.flatMap(file => [...readFileSync(join(appRoot, file), 'utf8')
    .matchAll(/\$\((INSTALLER_[A-Z0-9_]+)\)/gu)].map(match => match[1]!)))].sort()
  expect(keys).toContain('INSTALLER_REBOOT_REQUIRED')
  for (const locale of readInstallerLocales()) {
    const source = renderInstallerStrings([locale])
    for (const key of keys) {
      expect(locale.strings[key], `${locale.id}: ${key}`).toEqual(expect.any(String))
      expect(source).toContain(`LangString ${key} \${LANG_${locale.nsisLanguage}}`)
    }
  }
})

it.each(['en_US', 'zh_CN', 'ja_JP', 'es_ES', 'fr_FR', 'de_DE', 'ru_RU', 'pt_BR'])('rejects a missing %s configuration', (id) => {
  const directory = fixture()
  rmSync(join(directory, `${id}.json`))
  expect(() => readInstallerLocales(directory)).toThrow(`missing ${id}.json`)
})

it.each([
  ['missing key', (resource: ReturnType<typeof readInstallerLocales>[number]) => { delete resource.strings.INSTALLER_INSTALL }, 'keys differ'],
  ['extra key', (resource: ReturnType<typeof readInstallerLocales>[number]) => { resource.strings.INSTALLER_EXTRA = 'extra' }, 'keys differ'],
  ['empty text', (resource: ReturnType<typeof readInstallerLocales>[number]) => { resource.strings.INSTALLER_INSTALL = '' }, 'nonempty text'],
  ['changed placeholder', (resource: ReturnType<typeof readInstallerLocales>[number]) => { resource.strings.INSTALLER_NATIVE_PROGRESS = '%s%%' }, 'format placeholders'],
  ['changed diagnostic register', (resource: ReturnType<typeof readInstallerLocales>[number]) => { resource.strings.INSTALLER_VC_LAUNCH_FAILED = 'status: $0, detail: $2' }, 'format placeholders'],
  ['missing diagnostic register', (resource: ReturnType<typeof readInstallerLocales>[number]) => { resource.strings.INSTALLER_VC_EXIT_FAILED = 'failed' }, 'format placeholders'],
  ['missing percent escape', (resource: ReturnType<typeof readInstallerLocales>[number]) => { resource.strings.INSTALLER_NATIVE_PROGRESS = '%d%' }, 'format placeholders'],
  ['extra format specifier', (resource: ReturnType<typeof readInstallerLocales>[number]) => { resource.strings.INSTALLER_NATIVE_PROGRESS = '%d%% %q' }, 'format placeholders'],
  ['translated command', (resource: ReturnType<typeof readInstallerLocales>[number]) => { resource.strings.INSTALLER_THEME_ERROR = 'Use /THEME=claro.' }, 'format placeholders'],
  ['duplicate language', (resource: ReturnType<typeof readInstallerLocales>[number]) => { resource.nsisLanguage = 'ENGLISH' }, 'duplicate NSIS language'],
  ['invisible character', (resource: ReturnType<typeof readInstallerLocales>[number]) => { resource.strings.INSTALLER_INSTALL = 'Install\u200b' }, 'invisible'],
  ['byte-order mark', (resource: ReturnType<typeof readInstallerLocales>[number]) => { resource.strings.INSTALLER_INSTALL = 'Install\ufeff' }, 'invisible'],
  ['invalid compiler token', (resource: ReturnType<typeof readInstallerLocales>[number]) => { resource.nsisLanguage = 'JA\n!error' }, 'invalid NSIS language'],
])('rejects %s', (_name, mutate, diagnostic) => {
  const directory = fixture()
  const resource = readInstallerLocales(directory).find(locale => locale.id === 'ja_JP')!
  mutate(resource)
  writeFileSync(join(directory, 'ja_JP.json'), JSON.stringify(resource))
  expect(() => readInstallerLocales(directory)).toThrow(diagnostic)
})

it('escapes literal NSIS syntax without changing translated text', () => {
  const locale = readInstallerLocales()[0]!
  expect(renderInstallerStrings([{ ...locale, strings: { INSTALLER_INSTALL: '"$name"\nnext\rline' } }]))
    .toContain('"$\\"$$name$\\"$\\nnext$\\rline"')
})

it('interpolates prerequisite diagnostic registers while keeping other dollar signs literal', () => {
  const locale = readInstallerLocales()[0]!
  const source = renderInstallerStrings([{ ...locale, strings: {
    INSTALLER_VC_EXIT_FAILED: 'exit: $2; literal: $0',
    INSTALLER_VC_LAUNCH_FAILED: 'status: $0, detail: $1; literal: $2',
    INSTALLER_INSTALL: 'literal: $0 $1 $2',
  } }])
  expect(source).toContain('"exit: $2; literal: $$0"')
  expect(source).toContain('"status: $0, detail: $1; literal: $$2"')
  expect(source).toContain('"literal: $$0 $$1 $$2"')
})

it('uses the real electron-builder language identifiers and English fallback', () => {
  const locales = readInstallerLocales()
  expect(locales[0]?.id).toBe('en_US')
  expect(locales.map(locale => locale.id.split('_')[0]).sort()).toEqual([...SHIPPED_LOCALE_IDS].sort())
  createAddLangsMacro({ macro: (_name, lines) => {
    expect(lines.map(line => /MUI_LANGUAGE "([^" ]+)"/u.exec(line)?.[1]?.toUpperCase()))
      .toEqual(locales.map(locale => locale.nsisLanguage))
  } }, new LangConfigurator({ installerLanguages: locales.map(locale => locale.id) }))
})

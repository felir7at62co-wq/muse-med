/** Activate the generated Client closure; the built-artifact lane runs after the Client build. */
import { existsSync, readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as Cordis from '@deepseek-ai/cordis'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import {
  createClientModuleSystem,
  type ClientBundleRegistration,
  type ClientModuleLoaderTarget,
} from '@deepseek-ai/dsh-client-modules/client'
import { describe, expect, it } from 'vitest'

const ID = '@deepseek-ai/dsh-drama-settings'
const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const artifact = new URL('../lib/client.js', import.meta.url)

describe.skipIf(!existsSync(artifact))('built settings Client closure', () => {
  it('activates through the production module table with the shipped platform modules', async () => {
    const pendingQueue: ClientBundleRegistration[] = []
    const bootstrap = { id: MODULES_ID, exports: { createClientModuleSystem } }
    const target: ClientModuleLoaderTarget = {
      mode: 'queue',
      pendingQueue,
      load: (registration) => { pendingQueue.push(registration) },
      create: options => createClientModuleSystem(target, bootstrap, options),
    }
    runInNewContext(readFileSync(artifact, 'utf8'), { window: { __ModuleLoader__: target } })
    const url = `plugins/??${ID}/client.js&rev=fixture`
    const modules = target.create({
      boot: {
        rev: 'fixture',
        entries: [{ id: ID, url, rev: 'fixture' }],
        batches: [{ phase: 'application', url, rev: 'fixture', entries: [ID] }],
      },
      staticModules: {
        react: React,
        'react/jsx-runtime': jsxRuntime,
        '@deepseek-ai/cordis': Cordis,
        '@deepseek-ai/dsh-client-ui-primitives': primitives,
      },
      loadBundle: () => { throw new Error('The generated factory must already be registered') },
    })
    const exports = await modules.import(`${ID}/client`)
    expect(exports).toMatchObject({ inject: ['slots', 'locale', 'configForms'] })
    expect(Reflect.get(exports, 'apply')).toBeTypeOf('function')
    expect(modules.loadCache.get(ID)?.edges).not.toContain('@deepseek-ai/dsh-typert-protocol')
  })
})

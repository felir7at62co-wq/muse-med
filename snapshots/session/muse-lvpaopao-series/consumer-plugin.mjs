/** Load the real Agent-scoped consumer and complete series executor. */
import { importLvpaopaoSnapshot } from '../muse-lvpaopao/plugin-import.mjs'
export const { name, inject, Config, apply } = await importLvpaopaoSnapshot('index')

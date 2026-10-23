/** Load the production tool consumer without replacing its executor. */
import { importLvpaopaoSnapshot } from './plugin-import.mjs'
export const { name, inject, Config, apply } = await importLvpaopaoSnapshot('index')

/** Reuse the production module selector without modifying its existing snapshot owner. */
import { importLvpaopaoSnapshot } from '../muse-lvpaopao/plugin-import.mjs'
const { default: Bridge } = await importLvpaopaoSnapshot('bridge')
export default Bridge

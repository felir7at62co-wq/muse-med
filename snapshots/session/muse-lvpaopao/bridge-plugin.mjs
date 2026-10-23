/** Load the production Host bridge in the subprocess's active source or built mode. */
import { importLvpaopaoSnapshot } from './plugin-import.mjs'
const { default: Bridge } = await importLvpaopaoSnapshot('bridge')
export default Bridge

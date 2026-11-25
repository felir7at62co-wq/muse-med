/** The Script Workshop gateway mount, API root and native credential. @module */
import type { WorkbenchDefinition } from './sessions.ts'

/** The Script Workshop connection used by the Workshop Host service. */
export const SCRIPT_WORKSHOP: WorkbenchDefinition = {
  audience: 'script-workshop', name: '剧本工坊', code: 'WORKSHOP', mount: 'jubengongfang', api: '/v1',
  credential: 'access_token', profileUser: profile => profile,
  changed: '剧本工坊连接已变更。请核对原账号下已提交的任务。',
}

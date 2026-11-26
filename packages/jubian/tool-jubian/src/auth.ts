/** Read-only connection diagnosis; it never renews credentials or submits generation. */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { JubianError, type JubianClient } from '@deepseek-ai/dsh-jubian'
import { readScriptList } from '@deepseek-ai/dsh-jubian-api'

/** Preserve the provider failure category on the recorded tool result. */
class JubianAuthenticationCheckError extends HarnessError {
  readonly detail: string | undefined
  readonly responseEvidence: JubianError['responseEvidence']

  constructor(error: JubianError) {
    const next = error.code === 'AUTHENTICATION_REQUIRED'
      ? 'Check the credential used by Muse. Renew it in Muse settings if the server rejected it; website sign-in alone does not update that value.'
      : error.code === 'PERMISSION_DENIED'
        ? 'Access was denied; this does not prove login expiry. Check account access before signing in again.'
        : 'This failure does not prove login expiry. Check the reported connection or response error; no generation was submitted.'
    super(`${error.code}: ${error.message}. ${next}`, error.code, { cause: error })
    this.name = 'JubianAuthenticationCheckError'
    this.detail = error.detail
    this.responseEvidence = error.responseEvidence
  }
}

/**
 * Read one bounded page with the credential currently resolved by Muse.
 * @param client - Live credential-resolving transport; no credential snapshot is retained.
 * @returns Only access evidence, without provider rows, account identity or credentials.
 */
export async function authenticationMethod(client: JubianClient): Promise<Record<string, unknown>> {
  try {
    const result = await client.request({ method: 'GET', path: '/aigc/script/list?pageNum=1&pageSize=1' })
    readScriptList(result.data)
    return { authentication: { status: 'read_access_confirmed', checked: 'own_project_list',
      http_status: result.transport.http_status, application_code: result.transport.application_code,
      generation_submitted: false,
      note: 'The credential currently used by Muse can read this list. Project-specific access and paid generation have not been verified.' } }
  } catch (error) {
    if (error instanceof JubianError) throw new JubianAuthenticationCheckError(error)
    throw error
  }
}

/**
 * Host half of the Jubian token Settings page: the `jubianToken` Remote
 * namespace, over exactly one credential reference.
 *
 * **One reference, fixed here.** `ctx.remote.credentials` writes any reference
 * a page names; this namespace writes only {@link JUBIAN_TOKEN_REF}, so the
 * browser that owns this page cannot repoint another provider's credential
 * even if the page is compromised.
 *
 * **The value crosses in one direction.** `set` takes a value; no method
 * returns one. Every answer is the credential seam's own configuration view —
 * configured, source, writable — projected field by field, because the Gateway
 * carries a business result without decoding it and a provider that returned
 * extra properties would otherwise widen what reaches the browser.
 *
 * @module @deepseek-ai/dsh-tool-jubian/src/token
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import { JUBIAN_TOKEN_REF } from '@deepseek-ai/dsh-jubian'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import './types.ts'

/** The one reference this namespace reads and writes. */
const REF = credentialRef(JUBIAN_TOKEN_REF)

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `jubianToken` Remote namespace. */
    jubianToken: JubianToken
  }
}

/**
 * Copy exactly the fields {@link CredentialInfo} declares.
 * @param info - the provider's answer for the Jubian reference.
 * @returns the same facts with nothing else attached.
 */
function viewOf(info: CredentialInfo): CredentialInfo {
  return {
    configured: info.configured,
    ...info.source === undefined ? {} : { source: info.source },
    writable: info.writable,
  }
}

/**
 * Host service backing the generated `ctx.remote.jubianToken` namespace: the
 * Jubian admin token as the Web Settings page reads, writes, and clears it.
 */
export class JubianToken extends TypertRemoteService {
  static inject = ['credentials']

  /** @param ctx - Host context carrying the credential provider. */
  constructor(ctx: Context) {
    super(ctx, 'jubianToken')
  }

  /**
   * Describe the stored token without reading it.
   * @returns whether a value is configured, which source supplies it, and whether this deployment can write it.
   */
  @Remote
  async describe(): Promise<CredentialInfo> {
    return viewOf(await this.ctx.credentials.describe(REF))
  }

  /**
   * Store one value under the fixed reference.
   * @param value - the token; an empty or whitespace-only value is refused.
   * @returns the same facts {@link describe} reports after the write.
   * @throws RemoteError when the value is empty, or when the provider refuses the write.
   */
  @Remote
  async set(value: string): Promise<CredentialInfo> {
    if (value.trim().length === 0) {
      throw new RemoteError(
        'gateway/bad-request',
        'the Jubian admin token must not be empty; clear it with unset instead',
        {},
      )
    }
    await this.write(() => this.ctx.credentials.set(REF, value))
    return await this.describe()
  }

  /**
   * Remove the stored value. Removing an absent reference is a no-op.
   * @returns the same facts {@link describe} reports after the removal.
   * @throws RemoteError when the provider refuses the write.
   */
  @Remote
  async unset(): Promise<CredentialInfo> {
    await this.write(() => this.ctx.credentials.unset(REF))
    return await this.describe()
  }

  /**
   * Run one write and report a refusal with the seam's own message. A
   * read-only source shadowing the reference is what the page must show
   * verbatim, and the details carry no field a value could ride in.
   * @param write - the credential operation to run.
   */
  private async write(write: () => Promise<void>): Promise<void> {
    try {
      await write()
    } catch (error: unknown) {
      throw new RemoteError(
        'jubian-token/rejected',
        error instanceof Error ? error.message : String(error),
        { ref: JUBIAN_TOKEN_REF },
        { cause: error },
      )
    }
  }
}

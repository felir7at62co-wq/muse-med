/**
 * The opt-in response dump an operator turns on to send back what the remote
 * actually returned.
 *
 * It is off unless `DSH_JUBIAN_DEBUG_DUMP` names a file, so no shipped path ever
 * writes provider payloads on its own. A record carries the request line, the
 * transport outcome and the redacted payload — request headers, including
 * `Authorization`, are never read here, and the redaction is the same one the
 * error diagnostics use: credential-named fields removed, absolute URLs reduced
 * to their origin, strings and containers bounded. The file is created with
 * owner-only permissions where the platform honors them.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The environment variable naming the dump file; absent or blank leaves the dump off. */
export const DEBUG_DUMP_ENV = 'DSH_JUBIAN_DEBUG_DUMP'

/** One appended line, as the JSONL file carries it. */
export interface JubianDebugRecord {
  /** When the response was read, from this process's clock. */
  at: string
  /** HTTP method of the call the response answered. */
  method: string
  /** Path the call went to; the query string is kept because it carries the read's parameters. */
  path: string
  /** HTTP status, or null when the call never produced one. */
  http_status: number | null
  /** Application envelope code, or null when the body carried none. */
  application_code: number | null
  /** Which envelope layout the body used, for tightening the tolerated ones later. */
  envelope_layout: string
  /** Hash of the exact response bytes, matching what the ledger records. */
  response_sha256: string | null
  /** Response byte length. */
  bytes: number
  /** The redacted payload, or a redacted excerpt when the body never parsed. */
  body: unknown
}

/** One dump file, appended to once per response while the operator keeps it enabled. */
export class JubianDebugDump {
  private readonly path: string

  private constructor(path: string) {
    this.path = path
  }

  /**
   * Read the switch from an environment.
   * @param environment - Environment to read; defaults to `process.env`.
   * @returns The dump the variable names, or null when it is unset or blank.
   */
  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): JubianDebugDump | null {
    const configured = environment[DEBUG_DUMP_ENV]?.trim()
    return configured ? new JubianDebugDump(configured) : null
  }

  /**
   * Append one record.
   *
   * The dump is diagnostic: an unwritable path must not fail, delay beyond its
   * own write, or otherwise change the call it observes.
   * @param entry - The response line, without its timestamp.
   */
  async record(entry: Omit<JubianDebugRecord, 'at'>): Promise<void> {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`
    try { await mkdir(dirname(this.path), { recursive: true }) }
    catch { /* the dump is opt-in diagnostics: an uncreatable directory must not fail the call */ }
    try { await appendFile(this.path, line, { encoding: 'utf8', mode: 0o600 }) }
    catch { /* the dump is opt-in diagnostics: an unwritable file must not fail the call */ }
  }
}

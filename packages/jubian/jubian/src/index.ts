/** Jubian HTTP transport, credential repair, stable error codes and the write-path ledger. */
export { JUBIAN_TOKEN_REF, isUsableBearerToken, trimBearerToken } from './credential.ts'
export { JubianError, codeForHttpStatus, failureForEnvelopeCode } from './error.ts'
export type { JubianErrorCode } from './error.ts'
export { JubianLedger } from './ledger.ts'
export { AUTHORIZATION_FILE, SPENDING_METHODS, authorizationPathFor, centsOf, checkBudget, readAuthorization,
  readProjectBudget, updateProjectBudget } from './budget.ts'
export type { BudgetAuthorization, BudgetDecision, ProjectAuthorization, BudgetApproval, ProjectBudgetUpdate } from './budget.ts'
export type { ProjectBudget } from './types.ts'
export type { JubianLedgerBegin, JubianLedgerBeginResult, JubianLedgerMethod, JubianLedgerOptions,
  JubianLedgerRecord, JubianLedgerSettlement } from './ledger.ts'
export { JUBIAN_DEFAULT_BASE_URL, JubianClient } from './client.ts'
export type { JubianClientOptions, JubianEnvelopeLayout, JubianRequest, JubianResponse } from './client.ts'
export { describeBodyRejection, describePayload, describeRejection, describeUnparsed, namesCaptureSwitch,
  redactForDump } from './diagnostic.ts'
export { DEBUG_DUMP_ENV, JubianDebugDump } from './debug-dump.ts'
export type { JubianDebugRecord } from './debug-dump.ts'

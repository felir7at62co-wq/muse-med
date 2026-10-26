/** Release metadata for the Desktop Host lifecycle protocol. */

/** Lifecycle protocol generation recorded in Desktop release metadata. */
export const DESKTOP_HOST_PROTOCOL_VERSION = 6 as const

/** The matching Desktop Host disposal grace; keep in step with its private protocol. */
export const DESKTOP_HOST_SHUTDOWN_GRACE_MS = 25_000

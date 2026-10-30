/** Private Main/Host wire generation advertised before admitting browser operations. */
export const DESKTOP_HOST_PROTOCOL_VERSION = 7 as const

/** Heavy desktop task trees need longer than the CLI's five-second disposal grace. */
export const DESKTOP_HOST_SHUTDOWN_GRACE_MS = 25_000

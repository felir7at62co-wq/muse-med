import type { Board, Channel, Period } from './parser.js';

export interface MetadataConfig { maxResponseBytes: number; allowLegacyResponseHeaders: boolean; }
export function rankingApiPath(options: { channel: Channel; board: Board; period: Period; page: number; month?: string }): string;
export function metadataUrl(path: string): URL;
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T>;
export function legacyHtml(url: URL, config: MetadataConfig, signal: AbortSignal): Promise<string>;
/** Validates bounded legacy HTTP framing and bytes after a caller has admitted its own fixed source URL. */
export function readLegacyResponse(response: import('node:http').IncomingMessage, config: MetadataConfig, json?: boolean): Promise<string>;
export function readMetadata(path: string, config: MetadataConfig, signal: AbortSignal, dependencies?: {
  fetch?: typeof globalThis.fetch;
  legacyRequest?: (url: URL, config: MetadataConfig, signal: AbortSignal) => Promise<string>;
}): Promise<{ html: string; transport: 'fetch' | 'https_legacy_headers' }>;

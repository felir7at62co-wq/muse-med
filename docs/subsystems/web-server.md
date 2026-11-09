# HTTP Server

English | [中文](web-server.zh.md)

[dsh-host-webserver](../../packages/host/webserver) is the browser HTTP carrier for the GUI host: one `node:http` server — `node:https` when `tls` is configured — providing `ctx.webServer`, a named-route registry, optional gzip response compression, index.html transform callbacks, and one fallback, a handler or a resource, that a plugin may claim. It is not part of the agent loop and not a capability seam; its only harness concept is the Peer an index render speaks for, and another plugin registers every feature route, including the `/api` bridge, plugin bundles, and the HMR event stream ([layering reference](../../packages/boot/app-boot/README.md)). It serves browsers only: Electron loads the built files over `file://` and sends fetch requests through an IPC bridge instead of this server.

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

## Routes

```ts type-equiv
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
type WebRouteKind = 'exact' | 'prefix'
```

```ts type-equiv
/** One named route registration. */
interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
```

```ts type-equiv
/**
 * Answers one GET or HEAD request with a Fetch response. An HTTP request
 * arrives without a Peer and carries the client's headers; an in-process
 * {@link WebServer.readResource} read passes the Peer its caller admitted.
 */
type WebResource = (request: Request, peer?: PeerScope) => Promise<Response>
```

```ts type-equiv
/** One named route answered by a resource instead of a handler. */
interface WebResourceRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Answers HTTP GET and HEAD requests and in-process reads. */
  resource: WebResource
}
```

Match order is fixed: exact table first, then longest matching prefix, then the registered fallback. Registration order carries no request-facing semantics — named routes are composed to be disjoint, and the fallback seat answers anything no named route claims; one owner only, a second registration throws. The shipped Web composition claims the seat with [`dsh-host-frontend-static`](../../packages/host/frontend-static/src/index.ts), the SPA dist server with locked semantics: Connection authenticates the dist root and configured index before their HTML is read; non-index assets remain public; non-GET/HEAD is 405, traversal outside the dist root is 403, existing files are served directly, absent or non-file targets are empty 404 responses, and unknown extensions ship as octet-stream.

A route or the fallback may give a resource, a function from a Fetch `Request` to a `Response`, instead of a handler. HTTP `GET` and `HEAD` requests reach it without a Peer, and `readResource(request, peer)` reads it in process for the Peer its caller admitted; a read follows the same match order but reaches only resources, so a route that returns owner-private data or performs an action stays a handler even when it answers `GET`.

<a id="config"></a>

## Config

```ts type-equiv
/** Web server listen, TLS, and response-compression config. */
interface Config {
  /**
   * Listen address: a concrete IPv4 or IPv6 literal of one local interface,
   * for example the container's own Pod address from `hostname -i`. A loopback
   * literal (any address in 127/8, `::1`, or a mapped form of either) keeps the
   * server on this machine; any other literal serves the network that address
   * belongs to, over plain HTTP unless `tls` is set. The unspecified address —
   * IPv4 any, IPv6 any, and the IPv4-mapped forms of IPv4 any — is rejected at
   * load: it would expose the port on every interface at once.
   */
  host: string
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /**
   * Serve HTTPS with this certificate and key instead of plain HTTP. Both files
   * are read once, before the listener binds: an unreadable or empty file,
   * invalid PEM, or a key that does not match the certificate rejects
   * initialization rather than falling back to HTTP. The material is never
   * re-read, so replacing a certificate takes a reload. Omitted or null listens
   * over plain HTTP.
   */
  tls?: TlsConfig
  /** Response compression for socket-backed HTTP requests. @default 'none' */
  compression?: 'none' | 'gzip'
  /** Gzip DEFLATE level from 0 through 9. @default 1 */
  compressionLevel?: number
  /** Minimum known response length eligible for gzip; unknown-length streams are eligible. @default 1024 */
  compressionThresholdBytes?: number
}
```

```ts type-equiv
/**
 * TLS material for the HTTPS listener: one certificate chain file and the
 * private key file it pairs with. Both hold PEM text and both resolve against
 * the process working directory.
 */
interface TlsConfig {
  /** Certificate chain file, leaf certificate first, PEM, no passphrase. */
  certFile: string
  /** Private key file for the chain's leaf certificate; unencrypted PEM. */
  keyFile: string
}
```

No composition can bind every interface at once: the unspecified address is rejected at load. The exported `isWildcardHost` and `isLoopbackHost` classify a bind address from its parsed value, and an IPv6 `%zone` is kept for `listen` while classification reads the address alone. The carrier owns no authentication or Origin policy, and it serves plain HTTP unless `tls` supplies a certificate and key. `compression` defaults to `none`; the shipped Web bundle selects gzip level 1 with a 1024-byte threshold. The shipped `dsh web` command selects loopback by default and accepts one concrete `--host` address, warning at startup when a non-loopback bind serves plain HTTP; its Connection plugin supplies Host/Origin checks plus browser-session authentication for every Host API route and stream, and the bind address plus `--trusted-host` govern which browser Host is accepted; `--public-url` changes only the advertised URL. Other compositions own their bind and route-authentication policy. The dist location is an assembly fact of the frontend plugin that claims the seat.

## The service

`WebServer` (`ctx.webServer`) listens immediately on activation; a listen failure (EADDRINUSE…) rejects initialization, and the boot process reports the failed fiber. The `tls` pair is read once before the listener binds, and an unreadable, empty, or mismatched pair rejects initialization the same way instead of falling back to HTTP. `register(route)` adds one named route and returns its disposer; a duplicate `(kind, path)` throws because route patterns are a composition-level contract and a collision is a misconfiguration. Gzip wraps eligible socket-backed responses inside the server, so handlers keep direct `ServerResponse` ownership, and a resource hands the service a `Response` to write back. Existing content encodings, `Cache-Control: no-transform`, ranges, SSE, ZIP, and the packaged `.gz` Worker image remain identity responses. `collectIndexInjections(peer)` gathers structured `IndexInjection` rows over one `webserver/index-inject` emit that passes the Peer the page speaks for, and `renderIndex(html, peer)` renders them into successful root and configured index responses before applying the raw `tapIndex(transform)` escape-hatch transforms in registration order; [dsh-client-modules](../../packages/client/modules) answers the event with the boot manifest rows. `port` reads the listening port, including the port assigned by the OS when `config.port` is 0, and `protocol` reports the scheme the listener serves (`http:` or `https:`).

A request whose handling throws (a malformed %-escape hitting `decodeURIComponent`, a client dropping mid-body) is logged as a warning and answered 400 — or the socket destroyed when headers are already out — never a process exit. Disposal pairs `close()` with `closeAllConnections()` because a handler may hold its response open (SSE) and such connections never end on their own; without the force-close, teardown would hang. A TLS socket counts as a connection only after its handshake, so the server tracks raw TLS sockets beside upgraded ones and destroys both at disposal. The package never prints: the URL line belongs to the shell. Per-package operational detail, including the dev-mode bundle watch pipeline, stays in the [README](../../packages/host/webserver/README.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconnection--hostconnectionhandle"></a>

### `ctx.connection` — `HostConnectionHandle`

Host `ctx.connection` members consumed by transport-independent adapters.

```ts cordis-catalog
/**
 * Compose exact Fetch routes and the shared-channel RPC interceptor.
 * @param channel - shared channel mounted by Connection.
 * @returns Fetch handler for trusted, authenticated requests.
 */
createSharedFetchHandler(channel: '/api'): ConnectionFetchHandler

/**
 * Apply Connection's Host/Origin checks and browser authentication to
 * another Web route.
 * @param request - request headers from the HTTP or upgrade request.
 * @returns rejection status, or undefined when the route may accept the request.
 */
requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection

/**
 * Admit an HTTP request against its signed browser or API credential and live Peer.
 * @param request - request headers from the HTTP or upgrade request.
 * @returns the credential's Peer, or the rejection status.
 */
admit(request: ConnectionTrustRequest): PeerAdmission

/**
 * Create an independent in-process Peer, disposed with the Context that read `ctx.connection`.
 * @param options - fixed principal and optional interaction participation (default `answer`).
 * @returns a new Peer distinct from every other Peer.
 */
createPeer(options: { readonly principal: Principal; readonly interactions?: 'answer' | 'none' }): PeerScope

/**
 * Claim a physical socket for an API Peer; browser sockets share their owner Peer.
 * @param request - authenticated upgrade request headers.
 * @returns the Peer and idempotent release, or 409 for duplicate API ownership.
 * The carrier releases on socket termination or failed upgrade; release removes
 * API admission synchronously without cancelling independent HTTP calls.
 */
admitConnection(request: ConnectionTrustRequest): ConnectionAdmission

/**
 * Authenticate one frontend index request, owning a token redirect or 401.
 * The cookie this mints is `Secure` when the mounted Web carrier serves TLS,
 * which only that listener's protocol decides.
 * @param request - root or configured-index HTTP request.
 * @param response - response owned when the result is false.
 * @returns true only when the frontend may serve index.html.
 */
authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean

/**
 * Add the fresh process token to an ordinary Web application URL.
 * @param baseUrl - clean application URL whose authority and mount are preserved.
 * @returns tokenized URL for initial login; a mount proxy strips its prefix before {@link authorizeIndex}.
 */
authenticatedUrl(baseUrl: string): string
```

Types: [Principal](typert.md)

Source: [`packages/client/connection/src/rpc.ts`](../../packages/client/connection/src/rpc.ts)

<a id="ctxmuseaccount--museaccountservice"></a>

### `ctx.museAccount` — `MuseAccountService`

MUSE account Remote namespace. The Connection carrier authenticates every call.

```ts cordis-catalog
/**
 * Coordinate a voice registration through the current private Muse account.
 * This Host-only method is deliberately absent from the renderer's Remote interface.
 * @param request - Exact original operation and project/person/life-period identifiers.
 * @param jubianToken - Private provider token for project-access verification.
 * @returns Wire response validated by the Jubian registration consumer.
 */
async requestVoiceSlot(request: MuseVoiceSlotRequest, jubianToken: string): Promise<unknown>

/**
 * Submit one explicitly authored remark to the signed-in Muse account's inbox.
 * @param request - Target, category, note and optional related-excerpt choice.
 * @returns A confirmed durable inbox receipt, without a cookie or transcript.
 */
@Remote('feedback') async feedback(request: MuseFeedbackRequest): Promise<MuseFeedbackReceipt>

/**
 * Submit audio through the current MUSE account; Host callers retain the job ID.
 * @param file - Local audio created from the authorized media.
 * @param id - Persisted idempotency UUID.
 * @param sha256 - SHA-256 digest of the audio.
 * @param language - Recognition language.
 * @param purpose - Receipt-bound use; omit only for a legacy receipt without a purpose.
 * @param signal - Cancellation of the local upload, without cancelling an accepted gateway task.
 * @returns Account-scoped task status without session or provider credentials.
 */
async submitAudio(file: string, id: string, sha256: string, language: 'zh' | 'auto', purpose?: MuseAsrPurpose, signal?: AbortSignal): Promise<MuseAsrJob>

/**
 * Query a previously submitted transcription without making another paid submission.
 * @param id - Persisted idempotency UUID.
 * @param signal - Cancellation of this status request.
 * @returns Task state and timed segments when complete.
 */
async audioStatus(id: string, signal?: AbortSignal): Promise<MuseAsrJob>

/**
 * Read the stored identity or confirm it with the gateway.
 * @param request - Whether to verify the cookie online.
 * @returns A browser-safe status without a cookie.
 */
@Remote('status') async status(request: MuseAccountStatusRequest): Promise<MuseAccountStatus>

/**
 * Sign in using UI-submitted credentials; registration requires an explicit choice.
 * @param request - Username, password and registration choice.
 * @returns The confirmed account identity and actual outcome, without credentials; post-login refresh failures do not replace it.
 */
@Remote('login') async login(request: MuseAccountLoginRequest): Promise<MuseAccountLoginResult>

/**
 * End and forget the current account session.
 * @returns Signed-out status after the gateway accepts the logout.
 */
@Remote('logout') async logout(): Promise<MuseAccountStatus>

/**
 * Start browser approval for this Desktop Host.
 * @returns A browser approval URL and matching code, without its redemption secret.
 */
@Remote('startBrowserLogin') async startBrowserLogin(): Promise<MuseBrowserLoginAttempt>

/**
 * Complete an approved login and refresh account consumers.
 * @param id - Attempt owned by this Host.
 * @returns Pending or terminal browser-safe state after local session persistence.
 */
@Remote('checkBrowserLogin') async checkBrowserLogin(id: MuseBrowserLoginId): Promise<MuseBrowserLoginResult>

/**
 * Cancel an unredeemed approval and read the account after any already-running commit settles.
 * @param id - Exact attempt to cancel.
 * @returns Current local account state.
 */
@Remote('cancelBrowserLogin') async cancelBrowserLogin(id: MuseBrowserLoginId): Promise<MuseAccountStatus>
```

Source: [`packages/host/muse-account/src/service.ts`](../../packages/host/muse-account/src/service.ts)

<a id="ctxmusedesktopbridge--musedesktopbridge-abstract-seam"></a>

### `ctx.museDesktopBridge` — `MuseDesktopBridge` (abstract seam)

Provider factory for an account-bound desktop, using the existing Host authority.

```ts cordis-catalog
/**
 * Create a stopped tunnel. Neither account cookies nor loopback cookies appear in URLs.
 * @param options - Verified account and local Host connection settings.
 * @returns Tunnel whose owner must await stop during account changes and disposal.
 */
abstract createTunnel(options: MuseDesktopTunnelOptions): MuseDesktopTunnel
```

Source: [`packages/host/muse-account/src/desktop-bridge.ts`](../../packages/host/muse-account/src/desktop-bridge.ts)

<a id="ctxmusemarket--musemarket"></a>

### `ctx.museMarket` — `MuseMarket`

Local publication service; installing a package never registers or executes its Skill.

```ts cordis-catalog
/** List current authoring candidates without reading or uploading resource directories.
 * @returns Discovered metadata and whether every provider completed this observation.
 */
@Remote('sources') async sources(): Promise<{ skills: { name: string; description: string; whenToUse?: string }[]; complete: boolean }>

/** Prepare one selected local Skill as a disabled publication without uploading it.
 * @param metadata - Explicit author metadata.
 * @param skillName - Exact registry invocation name.
 * @returns Verified disabled installation containing the selected complete bundle.
 */
@Remote('prepare') async prepare(metadata: MarketMetadata, skillName: string): Promise<MuseMarketInstallation>

/** Import a user-selected publication without activation or network access.
 * @param base64 - Complete, canonical base64 ZIP bytes.
 * @returns Matching installation or a newly committed disabled release.
 */
@Remote('importPackage') async importPackage(base64: string): Promise<MuseMarketInstallation>

/** List retained publication records; none is activated by this service.
 * @returns Validated disabled local installations.
 */
@Remote('installed') async installed(): Promise<MuseMarketInstallation[]>

/** Export original package bytes after verifying every extracted resource.
 * @param id - Exact installed release identity.
 * @returns Portable filename and complete canonical base64 ZIP.
 */
@Remote('exportPackage') async exportPackage(id: MarketReleaseId): Promise<{ name: string; base64: string }>

/** Remove a disabled publication record without deleting reusable archive bytes.
 * @param id - Exact installed release identity.
 */
@Remote('removePackage') async removePackage(id: MarketReleaseId): Promise<void>
```

Source: [`packages/host/muse-market/src/index.ts`](../../packages/host/muse-market/src/index.ts)

<a id="ctxwebapp--webapp"></a>

### `ctx.webApp` — `WebApp`

The Web GUI this process serves, provided by the `web-runtime` row.

```ts cordis-catalog
/**
 * The URL this GUI advertises, also used for `DSH_WEB_URL` and the startup URL line.
 * @returns the configured `publicUrl`, otherwise the listener origin.
 */
getAdvertisedUrl(): string
```

Source: [`packages/bundle/web-app/src/index.ts`](../../packages/bundle/web-app/src/index.ts)

<a id="ctxwebserver--webserver"></a>

### `ctx.webServer` — `WebServer`

The browser HTTP carrier service. Activation loads any configured TLS material, then listens immediately; a material or listen failure rejects initialization, and the boot process reports the failed fiber. Route registration order does not affect requests because configured named routes must be distinct, and a request no named route matches is answered 404 until the fallback owner registers.

```ts cordis-catalog
/**
 * The root URL local clients use to reach the bound listener: the protocol,
 * the {@link bindUrlHost} form of the bind address, and the listening port.
 * @returns the origin, for example `http://127.0.0.1:3080`.
 * @throws before `listen` binds a port, or when the bind address has no URL form.
 */
getOrigin(): string

/**
 * Register a named route. Duplicate (kind, path) throws — route patterns are
 * a composition-level contract, so a collision is a misconfiguration.
 * @param route - kind, path, and the owning handler or resource.
 * @returns the disposer removing the route.
 */
register(route: WebRoute | WebResourceRoute): () => void

/**
 * Register an exact-path HTTP upgrade route. Duplicate paths throw because
 * one socket can have only one protocol owner.
 * @param route - pathname and handler owning negotiation plus socket use.
 * @returns the disposer removing the route.
 */
registerUpgrade(route: WebUpgradeRoute): () => void

/**
 * Claim the fallback seat: the handler or resource answering every request
 * no named route matches (the SPA dist server in the shipped Web
 * composition). One owner only — a second registration throws, because two
 * fallbacks cannot compose.
 * @param fallback - a handler owning the full response lifecycle of
 * unmatched requests, or `{ resource }` answering them.
 * @returns the disposer releasing the seat.
 */
registerFallback(fallback: WebRoute['handler'] | Pick<WebResourceRoute, 'resource'>): () => void

/**
 * Read the response an HTTP request for the same URL would receive, as the
 * resource computes it for `peer`, without an HTTP exchange. The request
 * path picks the responder by the HTTP match order — exact, longest prefix,
 * then the fallback — and only a resource answers. This method checks no
 * cookie, Host, or Origin: the caller admits the reader before reading.
 * @param request - the read; its URL path selects the responder.
 * @param peer - the Peer the read speaks for, passed to the resource.
 * @returns the resource's response, without a body for HEAD as over HTTP;
 * 405 with `Allow: GET, HEAD` for any other method, checked before matching,
 * where over HTTP a handler route or an unmatched path answers such a
 * method itself; 404 when the path matches a handler route, or reaches the
 * fallback seat while it is unclaimed or holds a handler. A resource that
 * throws rejects the read, where an HTTP request would receive 400.
 */
async readResource(request: Request, peer: PeerScope): Promise<Response>

/**
 * Register a raw-HTML index transform, the escape hatch for markup no
 * {@link IndexInjection} row expresses: {@link renderIndex} applies taps in
 * registration order after rendering the structured rows.
 * @param transform - pure html-to-html function.
 * @returns the disposer removing the transform.
 */
tapIndex(transform: (html: string) => string): () => void

/**
 * Run an index.html body through the registered taps in registration order
 * — called by the fallback owner on every index response it renders.
 * @param html - the raw index.html body.
 * @returns the transformed body.
 */
applyIndexTaps(html: string): string

/**
 * Gather the structured injection table for one Peer: one
 * `webserver/index-inject` emit, every subscriber pushes its current rows.
 * Fresh per call, so subscribers read live state (module graph, theme
 * preference, the Peer's access) at emit time.
 * @param peer - the Peer the page speaks for.
 * @returns rows in subscriber activation order.
 */
collectIndexInjections(peer: PeerScope): IndexInjection[]

/**
 * Render one index.html body for one Peer: the structured injection table
 * first, then the raw `tapIndex` transforms over the result.
 * @param html - the raw index.html body.
 * @param peer - the Peer the page speaks for.
 * @returns the transformed body.
 */
renderIndex(html: string, peer: PeerScope): string
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

<a id="connection-events"></a>

### `connection/*` events

<a id="connectionrequest--waterfall"></a>

#### `connection/request` — waterfall

Admit or wrap an authenticated shared API request, including body transfer. Existing requests continue when a listener refuses subsequent requests.

```ts cordis-catalog
/**
 * Admit or wrap an authenticated shared API request, including body transfer.
 * Existing requests continue when a listener refuses subsequent requests.
 * @param request - Authenticated incoming HTTP request.
 * @param response - Response owned until the delegated bridge settles.
 * @param next - Delegate to the next listener or the shared API bridge.
 * @mode waterfall
 */
'connection/request'(request: IncomingMessage, response: ServerResponse, next: () => Promise<void>): Promise<void>
```

Source: [`packages/client/connection/src/index.ts`](../../packages/client/connection/src/index.ts)

<a id="connectionupdate-pause--serial"></a>

#### `connection/update-pause` — serial

Stop accepting and drain client streams for an approved Desktop update.

```ts cordis-catalog
/**
 * Stop accepting and drain client streams for an approved Desktop update.
 * @mode serial
 */
'connection/update-pause'(): Promise<void>
```

Source: [`packages/client/connection/src/index.ts`](../../packages/client/connection/src/index.ts)

<a id="connectionupdate-resume--serial"></a>

#### `connection/update-resume` — serial

Resume client streams after a cancelled or failed Desktop update.

```ts cordis-catalog
/**
 * Resume client streams after a cancelled or failed Desktop update.
 * @mode serial
 */
'connection/update-resume'(): void
```

Source: [`packages/client/connection/src/index.ts`](../../packages/client/connection/src/index.ts)

<a id="webserver-events"></a>

### `webserver/*` events

<a id="webserverindex-inject--emit"></a>

#### `webserver/index-inject` — emit

Collect the structured index injection table for the page `peer` speaks for. Emitted on every index render and every worker boot-payload request; listeners push their current rows, so a row's data is read fresh at emit time.

```ts cordis-catalog
/**
 * Collect the structured index injection table for the page `peer` speaks
 * for. Emitted on every index render and every worker boot-payload
 * request; listeners push their current rows, so a row's data is read
 * fresh at emit time.
 * @param table - Mutable row table; listeners append in activation order.
 * @param peer - The Peer the rendered page speaks for.
 * @mode emit
 */
'webserver/index-inject'(table: IndexInjection[], peer: PeerScope): void
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)
<!-- END GENERATED cordis-surface -->

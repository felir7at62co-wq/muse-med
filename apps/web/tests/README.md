# apps/web browser e2e

English | [中文](README.zh.md)

These tests boot the real web composition in-process and drive it with real browsers over real HTTP. Chromium runs the full lane; the [model and reasoning picker scenario](declared-reasoning.e2e.ts) also runs in WebKit to cover native mouse focus behavior. [Session replay recovery](session-replay-reload.e2e.ts) also runs in WebKit, sharing the `fresh-round-trip` recording and expected output without rewriting them. It covers active-stream reload, completed-turn reload, and reopening a Session. The lane's mechanics — modes, fixtures, goldens, and the deliberate composition divergences from `dsh web` — are documented in [`scaffold.ts`](scaffold.ts) and the [browser e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md).

After installing workspace dependencies, install the browsers and their system dependencies from the repository root:

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install --with-deps chromium webkit
```

On Linux, `--with-deps` installs dependencies through the system package manager. The persistent CI VM must provide these dependencies through image maintenance; CI installs only the browser binaries, as required by the [failover runbook](../../../.agents/notes/implemented/process/2026-07-26-ci-failover-runbook.md).

Ordinary scenarios begin with no registered Workspace or Session and a durable marker recording a removed default Workspace, so explicit folder-selection scenarios retain control of their cwd. `launchWebScaffold({ firstUse: true })` leaves initialization eligible for startup scenarios.

Plain Web opens credential setup directly after the welcome notice. Its scenarios check that account sign-in choices, account menus and bonus requests remain absent while exercising real Settings and credential persistence. Desktop cases declare their carrier before boot and retain the account-menu geometry, sign-in and bonus-notice assertions.

The workspace file-reference recording supplies its historical two-skill catalog through an owned temporary skill directory, using the descriptors retained in the recorded Session and independent of personal or bundled skill roots. Its keyboard gesture collapses a selected draft at the end before inserting the next reference on macOS and Windows.

[Tool details](tool-details.e2e.ts) checks each historical call against the unchanged recorded Session and exercises current Schedule cards through a separate real Host turn. The ended list row is a UI precondition; it does not assert that a scheduled task ran.

[Muse personal models](muse-personal-models.e2e.ts) discovers a model from an owned local endpoint, saves its credential separately, and verifies settings rows, conversation selection, restart persistence and an adapter request. It boots the shipped desktop settings overlay without touching an installed Muse application.

Same-day message goldens use the shared `WEB_FIXTURE_TIME`: seeded transcripts pass it as `createdAt` and pin the browser calendar with `pinBrowserClock`; scenarios that submit live messages also use `pinHostClock` and restore it after teardown. These clocks advance with real elapsed time while keeping native timers intact, so midnight does not change a scenario's date labels.

Root-only recorded-session owners can preserve canonical replay inputs with [`writerOutput`](../../../packages/test-support/session-snapshot/README.md). The scaffold compares the driven root against a separate current-writer oracle and checks its exact inventory; it rejects child canonical roles for this Web option. Refresh may check the inventory before teardown harvests the root oracle; replay always requires it.

Built-bundle jsdom cases share `installAssembledBootEnv`, which supplies non-matching media queries and restores browser globals after each test; real media-query behavior belongs to browser cases.

The [Bot sidebar fixture](bot-sidebar-rail.e2e.ts) mounts the shipped navigation with a synthetic roster and empty Sessions. Its public navigation guard is cancelled on release. Narrow Web and macOS cases check the visible drawer, hit testing, keyboard focus and unreserved main column; Windows retains its rail. These geometry checks do not certify native Session operations.

## Completion observations

Desktop onboarding waits for the published balance result through a [read-only account observer](fixtures/plugins/fixture-onboarding-account/client.js). A held post-return response separates request arrival and enabled navigation from the failed result reaching the account subscription; the fixture disposes that subscription when its Client plugin stops.

Onboarding reload checks wait for the requested step to be saved on the Host. Queue snapshots observe the header, item count, collapsed state and pending submissions together before capturing the settled layout.

State-sensitive cases use Workspace, admission, attachment, and model-stream barriers to separate visible intermediate states from completed operations. Model-picker persistence assertions wait for the saved default, independently of menu closure. File-card geometry assertions wait for the exact rendered height, separately from Host turn completion and an earlier visibility observation. Details close waits for frame transitions; archive verification assigns an explicit title to the seeded Session and follows that identity across reload. The [CI test reliability workflow](../../../.agents/skills/dsh-ci-test-reliability/SKILL.md#synchronize-on-state) owns these synchronization rules.

The SVG delivery scenario includes bounded Host WebSocket observations in a connection-warning failure: Ping enqueue and write completion, Pong arrival, closure code and caller stack. Its real upgrade hook must observe the carrier, stays installed until Host cleanup finishes, and then restores its own methods and listeners. It records no frame bodies, request URLs, or unrecognized closure text; successful cases print no diagnostic output.

Permission-picker assertions wait for rendered option rows before checking counts or snapshots. Permission-command submission also waits for the composer draft to clear after the selected permission is published. The install-lifetime scenario owns a separate profile and browser, installs Auto as a bundle, and persists enablement through Plugin Manager with HMR active. Catalog-response completion precedes the existing DOM checks; current permission alone does not confirm catalog completion.

[Idle-submission handoff](idle-submission-handoff.e2e.ts) waits up to the scaffold's 30-second turn-completion budget for Host frames and browser placement. Vitest owns scaffold teardown so a replay-consumption error does not replace the failed scenario assertion.

Plugin-manager and HMR lifecycle switches wait up to `PLUGIN_TOGGLE_SETTLE_MS` (10 seconds) for the Host's profile write and the store's follow-up inventory read, the two steps that republish `aria-checked`; that constant's JSDoc records the measured chain.

Explicit scrolling uses `scrollIntoView` from `support.ts`: it resolves the locator again when its old element detaches and checks connection in the same browser task as native scrolling. Scenarios retain their visibility and geometry assertions after scrolling.

Question-composer resize assertions wait for overflow, the clipping mask, and toggle visibility to agree after CSS scroll timelines update.

[The snapshot after closing a sidebar pane](shortcuts-panels.e2e.ts) moves the pointer outside the controls and waits for hover tooltips to close before capture. Keyboard focus remains on the pane.

[The same-origin terminal case](sidebar-terminal.e2e.ts) waits for the UI-triggered Host close operation before checking process termination. It also checks the first window's process, saved bindings and layout after reload.

## These are Host-face tests

They type-check in the root `tsconfig.host.json`, not in the Client aggregate, because they read Host services directly: `ctx.connection`, the Host `SessionStore`, and `ctx.sessionProjectionCache`. Driving a browser at runtime does not make a file part of the Client program — the two faces merge Cordis `Context` under the same keys with different services, so one program cannot see both. Moving these files into the Client aggregate makes every Host-service access fail to compile.

A new scenario joins both program lists in the same change: its file in the root `tsconfig.host.json` include and in the Client aggregate's `apps/web/tsconfig.json` exclude. That project includes all of `tests`, so a file missing from the exclude compiles as Client code, and the Client compiler gate of `pnpm run typecheck` keeps failing with Host-service errors until it is listed.

## Do not import `@deepseek-ai/dsh-client-*` here

Importing a Client package — a value or a type — pulls its TypeScript project and referenced projects into the Host build graph. Generated Remote declarations are available before package compilation, but this does not make the Host and Client Cordis `Context` declarations compatible. Keep these tests on the Host face and use only the explicit built-client harness exception below.

When a scenario needs a Client-owned constant or pure function, mirror it here instead, next to the commented-out import that names the source module. A drift then surfaces as a missed selector or a stale mirrored value — a loud failure, never a silent pass. `scaffold.ts` follows this rule for the welcome-notice namespace, acknowledgement field, version, and asserted Chinese copy.

The built-client harness is the exception. `assembled-boot.ts` imports `AppWebEntry`, the boot-manifest type, and `RemoteMock`; `assembled-remote.ts` imports the Client test runtime's default responses and `RemoteMock`. These packages are explicit project references for booting the real shell against a test-owned carrier. The chat scenarios mirror `conversationContextKey` in `support.ts` instead of importing its Client owner.

Nothing mechanically enforces this rule; keep it in review.

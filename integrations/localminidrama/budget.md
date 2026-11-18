---
kind: reference
description: "Account-isolated project monetary authorization, configured prices and native production accounting."
---

# Project budgets and production accounting

English | [中文](budget.zh.md)

The primary Jubian workspace uses the existing Host token and maintained Jubian native fee approval. Its provider costs and original task receipts must not be mixed with this historical studio ledger. The controls below describe retained native/standalone projects; configuring them is not required to list or edit a Jubian project. Historical LTV records are read-only and are never converted into CNY authority.

## Scope

The authenticated studio stores budgets and monetary entries in each account’s SQLite database. Supported native production, independent TTS and Jubian video requests require an explicit project, currency and total authorization. Missing attribution, expired prices or insufficient funds refuse paid submission. Jubian also requires an enrolled Host and a one-use server fee challenge; page preparation, company allowance or a budget increase is not approval for this charge. Existing gateway login and Origin checks remain required.

The enforced comparison is `operator-confirmed invoices + every unsettled reservation + this reservation <= project limit`. Estimates control local admission; they do not impose a hard spending limit on a supplier. A configured token rate produces an estimate, not a verified invoice. An opaque Agent task has no verified model count, total usage or final price; its separately accepted envelope cannot restrict that Agent's eventual upstream consumption.

## Studio operation

Muse can request a project ceiling increase in the conversation with `localmini_budget.request_increase`. The native approval question identifies the project, currency, current commitments, additional estimate, requested total and reason. Only an explicit approval updates that project's budget; decline or cancellation leaves it unchanged and starts no generation. Muse checks the account, database, budget revision, commitments and quote again after approval. Changed inputs require a fresh request. A budget increase does not authorize a paid retry or change the administrator's maximum, model prices or existing spending. `read` and `quote` are free reads.

Open **Project budget and accounts** in the project header. Set the total authorization, then explicitly choose whether the project accepts model estimates. Unknown-task envelopes require their own separate risk choice; both choices default off. The ceiling cannot be lowered beneath existing invoices and unsettled commitments. Different currencies are never converted. Amounts use integer hundredths of the configured currency; the form accepts at most two decimal places.

Jubian video requires a `CNY` budget stored in integer fen. Historical `LTV` entries, credit units and unresolved holds remain available for traceability; they are not converted to CNY and cannot authorize a new Jubian call. A saved project cannot change currency directly. An existing credit budget stops execution until an administrator explicitly arranges CNY authorization without rewriting its original entries.

The same dialog lists configured model metadata and prices. An owner may add or edit an estimate unless the deployment administrator locks owner pricing. Select an existing API configuration's public metadata, or enter the actual service, provider, model and API Origin. The metadata picker selects no provider key. Specify the reservation amount, public price source or `operator-entered`, effective time and expiry. Model capability fields and optional token/character rates are configurable observations; they do not certify supplier support. Duplicate matching prices are refused at dispatch rather than selected silently. `agent-task` uses an entire-task envelope, never a single-image or single-video price.

The global API configuration page also offers a project selector and that project's budget dialog. Media/TTS configuration-format checks remain free and do not claim authenticated generation. A real text connection test requires an explicitly selected project, a stable native submission identity and its effective monetary authorization. It makes a real supplier request only after the budget permits it.

The ledger retains the original operation, immutable price snapshot, quantity and unconfirmed amount. Completion or failure does not mean the supplier waived its charge. Only a known terminal operation, or a distinct operator-confirmed Agent ending, permits final invoice reconciliation. Enter an exact amount and a nonsecret invoice reference, then explicitly confirm the final invoice. Zero requires the same explicit confirmation. The result remains `operator-confirmed-invoice` with `supplier_verified: false`; an unexpected actual overrun is recorded and blocks additional reservations. Unknown outcomes cannot be reconciled or released automatically.

## Accounting and recovery

Budget and price edits, invoice reconciliation and new reservations use SQLite immediate transactions. Mutations have stable operation identities and immutable receipts; reservation uniqueness is `(source, operation_id)`. Replaying a reservation returns `dispatch_allowed: false` and never acquires funds again. A changed request with the same identity is refused. A new identity with the same unresolved request hash is refused. Native admission also retains its original-request and explicit new-version rules.

A replayed budget edit returns its original receipt without replacing later edits. Read the project again before reporting the current ceiling or continuing production; the saved receipt is not a live balance. Increasing a ceiling retains every unsettled reservation and confirmed invoice. Generation still requires a fresh quote and the existing atomic reservation checks.

The private `muse_budget_schema` starts at version 1 and rejects unsupported versions. Each database owns an independent UUID. Budget, price, quote and invoice HTTP writes require that UUID, so an old page cannot mutate a replacement tenant with the same numeric project ID and revision. Restart changes unfinished reservation outcomes to unknown while retaining their full amounts. No timeout, cancellation, failed media validation or task error automatically releases money. Preparing TTS and Fal entries reserves funds inside their existing SQLite insertion transactions; a failed insertion rolls back its reservation too.

Native text and image calls check their actual configuration and reservation. Supplier usage stays linked to the original call, missing fields remain unknown, and TTS character rates can increase its reservation before dispatch. Jubian uses bindings, the live catalog and free preparation before an enrolled Host’s per-fee native approval and server validation permit submission; the former native video entry stays refused. New Fal submission and continuation are blocked until real-currency quotes and native fee approval are connected. Existing tasks retain free inspection, observation, download and explicit adoption. Unknown results retain their holds and do not authorize retries.

## Deployment

Register `planMuseBudget(root, readSource)` after the admission, audio, postproduction and package planners. It emits the service, routes, client helper and Vue dialog, and patches the staged dispatch functions. The account worker must allow `/api/v1/muse/budget/*`. Enabling this planner changes paid production admission: connecting an API alone does not authorize spending. Existing historical supplier costs are not backfilled as zero.

Optional private `muse_budget` settings are `currency` (default `CNY`), `max_project_limit_minor`, `allow_owner_prices` (default true) and `prices`. The administrator's maximum bounds owner ceiling edits; it does not fabricate a price or waive explicit project authorization. An administrator price has the same public fields as an owner price: `id`, `service`, `provider`, `model`, exact `origin`, optional `config_id`, `currency`, `reserve_minor`, `estimate_kind`, `source`, `effective_at`, `expires_at`, optional `rates` and `capabilities`. Services are `text`, `image`, `video`, `tts`, `postproduction` and `agent-task`. Native models use `per-dispatch-estimate`; an Agent task requires `operator-task-envelope`. All entries expose their configured source, effective interval and unverified status.

Rates are optional nonnegative integer hundredths per million input, output or total tokens, or per thousand request characters: `input_per_million_minor`, `output_per_million_minor`, `total_per_million_minor`, `characters_per_thousand_minor`. An explicit total rate takes precedence over input/output rates. Missing total tokens are never synthesized from input plus output. Capabilities are optional `maxDurationSeconds`, `maxReferenceImages`, `resolutions` and `supportsMultiVoice`; unknown values remain null or an empty resolution list. The native model adapter still owns actual parameter validation.

## API integration

| Method | Relative `/api/v1` path | Operation |
|---|---|---|
| GET | `/muse/budget/catalog` | Public prices, configuration metadata and database UUID |
| PUT | `/muse/budget/catalog/:id` | Explicit owner estimate, expected revision and stable mutation ID |
| GET / PUT | `/muse/budget/projects/:id` | Read or explicitly update one project authorization |
| GET | `/muse/budget/projects/:id/entries?limit=50&before=...` | Project totals and bounded ledger pages; maximum 100 entries |
| POST | `/muse/budget/quote` | Read a configured estimate without dispatching |
| POST | `/muse/budget/entries/:id/reconcile` | Explicit final invoice confirmation with expected entry revision |

Owner price writes require `operator_accepted: true`. Ceiling writes require `expected_revision`, `currency`, `limit_minor`, `allow_estimates`, `allow_task_envelopes` and `operation_id`. Reconciliation requires `expected_revision`, `amount_minor`, `source: 'operator-confirmed-invoice'`, `reference`, `final_invoice_confirmed: true` and `operation_id`. Every HTTP mutation also requires `database_id`; direct service helpers are trusted same-process operations.

Project reads advertise `budget_review_version: 1` when ceiling writes support a reviewed human decision. Such writes may include `expected_reserved_minor`, `expected_settled_minor` and `expected_quote: { spec, quote }`; `spec` contains the original quote selectors without a project ID, and `quote` is its complete response. The update checks commitments and recomputes that quote in the same SQLite transaction before changing the ceiling. Changed amounts, prices or expired quotes return `budget_review_changed` without saving the edit. A previously committed operation still replays its original receipt. Callers that require these checks must refuse a server without the advertised version; existing writes that omit the optional conditions retain revision-only behavior.

Integrated tasks reserve against a stable operation ID, project, request hash, actual provider/model, exact Origin and quantity. Only a first `dispatch_allowed: true` permits dispatch. Jubian `prepare` freezes the package revision, exact model specification, reference-image versions and CNY estimate. `run` reads original prepared inputs, obtains a server challenge bound to account, revision, request, connection and quote, then privately signs it only after Muse native approval. The server consumes it once. Administrator allowance is not human-approval proof. Changed inputs or prices require fresh approval; an unknown submission must be read by its original operation rather than resent under another ID. No browser endpoint asserts supplier completion or automatically releases an unknown hold.

Company admission separately checks company, member and project allowances and concurrency permissions, and must be configured by the gateway administrator. Raising a budget and approving generation are separate decisions. Retained historical supplier entries are read-only evidence. A model response, stdout or media decode is not a final supplier invoice; unreported charges must not become zero.

## Jubian guarantees and acceptance

| Muse/Jubian guarantee | Studio implementation |
|---|---|
| Explicit project total authorization | Owner budget submission, revision check and optional administrator maximum |
| Spend plus open intents plus quote fits | Immediate SQLite reservation over confirmed invoices and every unsettled hold |
| Missing project or price refuses spending | Project attribution checks and exact active profile matching |
| Operator estimate stays distinguishable | Separate explicit estimate/task-envelope authorization and immutable source metadata |
| Unknown intents continue to reserve | Restart-safe holds with no automatic cancellation or failure refund |
| Replays do not spend twice | Original native/TTS/Fal identities, reservation uniqueness and immutable mutation receipts |

Run `node --test integrations/localminidrama/tests/muse-budget.test.mjs`. Fixtures use real SQLite, HTTP, a separate process holding a writer lock and a real Vue/Element Plus browser. They verify monetary competition, retries, restart receipts, changed database identities, explicit invoice handling and a 390-pixel dialog without accessing existing accounts or paid suppliers. The owner-local expected receipt distinguishes estimates, unknown holds and human invoice confirmation. The selected supplier still needs authorized real API, pricing, final-invoice and quality acceptance; configured metadata and keyless fixtures do not establish those facts.

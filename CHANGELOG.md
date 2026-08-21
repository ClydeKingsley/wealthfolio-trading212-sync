# Changelog

All notable changes to Trading 212 Sync are documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.17] - 2026-08-21

### Changed

- Translate the complete add-on interface, confirmation prompts, sync notices,
  and date formatting to English.
- Correct the API-key guidance so it no longer asks users to enable the
  unnecessary Trading 212 Metadata scope.
- Clarify that the add-on is read-only toward Trading 212 while it creates
  securities and activities in the selected Wealthfolio account.
- Mark the package as private to prevent accidental npm publication and record
  the supported Node.js and pnpm toolchain.
- Set an explicit browser build target so the generated bundle does not drift
  when Vite changes its defaults.
- Add the public repository, support, author, and homepage metadata used by the
  first GitHub release.

### Security

- Include the MIT license in every installable ZIP.
- Add a private vulnerability-reporting policy and a credential-safety warning
  for public issues and pull requests.
- Add a least-privilege Windows CI workflow that type-checks, tests, builds, and
  packages the add-on from the lockfile.
- Pin the transitive Nano ID 3.x build dependency to the patched 3.3.18 release.

## [0.1.16] - 2026-08-01

### Fixed

- Treat a native asset's active flag as lifecycle state rather than security
  identity. An exact inactive asset left by a deleted account now reaches
  Wealthfolio's native `ensure_assets` path, which reactivates and reuses the
  same UUID before the activity is committed.
- Keep identity verification strict across UUID, symbol, exchange MIC, quote
  currency, instrument type, and every persisted ISIN field, both before and
  after native persistence.
- Create securities in a completely empty Wealthfolio catalogue from the exact
  market identity verified before `checkImport`; validation may enrich a row
  but cannot silently replace its symbol, MIC, currency, type, or provider.
- Add end-to-end regressions for a zero-security first sync, a newly purchased
  stock on a later sync, inactive-asset reactivation, validation identity drift,
  and a host that fails to reactivate after reporting a successful save.

## [0.1.15] - 2026-08-01

### Fixed

- Accept one unique existing Wealthfolio asset returned by an exact, validated
  ISIN lookup when Wealthfolio 3.6.2 omits ISIN from that native asset profile,
  provided its current UUID, active state, symbol, exchange, and currency all
  agree with the lookup result.
- Continue to stop before writing when any persisted ISIN field is invalid or
  conflicts with another value, or when the current native profile conflicts
  with the exact lookup.
- Include the affected Trading 212 instrument details in blocking review items
  so an identity failure remains diagnosable without exposing credentials.

## [0.1.14] - 2026-08-01

### Fixed

- Keep seen-state signatures stable when Wealthfolio changes a security from a
  newly created native asset to the same existing asset with a UUID on the next
  run. The crash-recovery ledger format remains byte-compatible with prior
  versions.
- Treat cancelled or unfilled order-history rows as non-blocking before asking
  for security enrichment that those rows do not need.
- When Trading 212 later omits enrichment from an already imported historical
  security row, require both its seen entry and one exact, unedited Wealthfolio
  source record before retaining it as a warning. New securities and current
  positions remain strict and continue to block on incomplete identity.
- Normalize BUY/SELL projected amount from quantity and unit price on both sides
  of post-write, duplicate, and recovery checks, avoiding JavaScript versus
  Rust Decimal rounding differences without weakening quantity, price, fee, or
  tax validation.
- Show blocking pending reasons before non-blocking review items in the saved
  summary and include the first concrete reason in the automatic-pause message.
- Reject recovery or duplicate evidence that is no longer posted or was edited
  by the user.

## [0.1.13] - 2026-08-01

### Fixed

- Recover an already committed Trading 212 batch whose marker was written by
  0.1.11 or an early 0.1.12 build before Wealthfolio's derived trade amount was
  accounted for. The recovery validates the original raw persisted payload,
  clears the marker without writing the 300 activities again, and then resumes
  reconciliation.
- Publish the recovery fix under a new version so Wealthfolio cannot retain an
  earlier 0.1.12 bundle that used the same manifest version.

## [0.1.12] - 2026-08-01

### Changed

- Resolve only securities referenced by this account's positions, orders, and
  dividends. The addon no longer requests Trading 212's unpaginated global
  instruments catalogue or requires the Metadata API-key scope.
- When an embedded Trading 212 instrument omits its type, require Wealthfolio's
  unique market result to identify it as a stock or ETF.
- Normalize a historical ticker alias to a unique current-position instrument
  with the same ISIN and quote currency before creating or reusing an asset.
- Use an exact ISIN market search only after a ticker lookup cannot resolve a
  historical alias; existing assets must carry the same verified ISIN.

### Fixed

- Avoid Wealthfolio 3.6.2's fixed addon-response size limit, which rejected the
  now oversized Trading 212 global instruments response before HTTP completion.
- Preserve a safe size-limit diagnostic and skip an identical retry when the
  host reports a deterministic oversized response.
- Treat Wealthfolio's derived `quantity × unitPrice` ActivityDetails amount as
  the documented projection of a trade rather than a persisted-field change,
  including recovery of a committed 0.1.11 batch.
- Keep automatic onboarding for newly purchased stocks and ETFs without UUID
  entry or a persisted manual asset map.

## [0.1.11] - 2026-08-01

### Added

- Fully automatic stock and ETF onboarding from the Trading 212 instruments
  catalogue and exact Wealthfolio market-data resolution.
- Native Wealthfolio `saveMany` asset creation/linking, including automatic
  onboarding when a supported security is bought after the addon is configured.
- Post-write asset-profile checks and cash/position reconciliation before
  automatic synchronization continues.
- Explicit source-record identity and idempotency data for retry-safe imports.

### Changed

- Removed the user-confirmed asset-mapping workflow. The addon no longer asks
  for, reads, or saves Wealthfolio asset UUID mappings.
- Removed the historical-cutoff workflow. New connections read all history made
  available by Trading 212 rather than deriving a boundary from local activity.
- The first successful full-history import now enables a read-only five-minute
  in-app synchronization timer.
- All accepted activities in a sync round are written through one native bulk
  save path.
- The documented Trading 212 access is limited to account data, portfolio,
  instruments metadata, and order/dividend/transaction history.

### Fixed

- Start each Trading 212 history stream with a documented `limit`-only request;
  later pages use only strictly validated `nextPagePath` values.
- Accept only the known compatible transaction pagination variants and route
  them to the canonical read-only endpoint.
- Send every Wealthfolio 3.6.2 activity field required by the native save wire.
- Sanitize safe-to-display Trading 212 HTTP validation errors without logging
  credentials, cursors, or request details.
- Handle Trading 212 ticker suffixes without truncating valid London symbols.

### Security

- Fail closed before writing when a security identity is missing, unsupported,
  conflicting, ambiguous, or cannot be reconciled.
- Store the API key pair only through Wealthfolio's operating-system-backed
  Secrets API.
- Declare no Trading 212 order-placement endpoint or Wealthfolio activity-import
  permission.

## [0.1.10]

### Added

- Full-history audit and fixed internal no-cutoff sentinel.
- Strict Trading 212 pagination validation and sanitized HTTP error reporting.

## [0.1.7]

### Added

- Initial read-only Trading 212 history synchronization, duplicate checks,
  account binding, and cash/position reconciliation.

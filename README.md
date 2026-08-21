# Trading 212 Sync for Wealthfolio

A community add-on that synchronizes a live Trading 212 Stocks & Shares ISA
with [Wealthfolio](https://github.com/wealthfolio/wealthfolio).

Version 0.1.17 imports the complete available Trading 212 history on first
connection and checks for new activity every five minutes while Wealthfolio is
open. It is read-only toward Trading 212: it never places, changes, or cancels
an order. It does create securities and activities in the selected Wealthfolio
account.

> [!IMPORTANT]
> This is an unofficial community project. It is not affiliated with, endorsed
> by, or supported by Trading 212 or Wealthfolio.

## Compatibility

| Component | Supported configuration |
| --- | --- |
| Wealthfolio | 3.6.2 or later; tested with 3.6.3 |
| Trading 212 | Live Stocks & Shares ISA |
| Wealthfolio account | GBP securities account using transaction tracking |
| Synchronization | Every five minutes while Wealthfolio is open |

Invest, CFD, practice, and non-ISA Trading 212 accounts are not supported.

## Highlights

- Full available history: no user-selected date and no cutoff derived from
  existing Wealthfolio activity.
- No UUID entry and no saved user-confirmed asset map.
- Automatic handling of securities bought after setup.
- Orders, dividends, interest, deposits, withdrawals, and supported trade-level
  fees and taxes.
- Source-record idempotency plus Wealthfolio duplicate checks.
- Cash and position reconciliation after each write.
- Automatic pause on any unsafe or ambiguous result.

## Automatic asset onboarding

Every sync uses the same pipeline for historical holdings and a stock or ETF
that appears for the first time in the future:

1. Read the instrument identity embedded in this account's positions, orders,
   and dividends; the addon never downloads Trading 212's global catalogue.
2. Build a complete source identity from ticker, ISIN, name, and quote
   currency. When Trading 212 supplies a type, validate it as well.
3. Search Wealthfolio market data for one exact, compatible market identity.
4. Send the activity and complete instrument specification through
   Wealthfolio's native `saveMany` asset pipeline, which creates or links the
   security and stores its generated asset ID with the activity.
5. Read the resulting asset profile and reconcile positions before allowing
   automatic sync to continue.

This works when Wealthfolio's securities catalogue is completely empty. If a
previously deleted account left behind an inactive exact security, Wealthfolio's
native save pipeline reactivates and reuses it instead of creating a duplicate.
Activation state is never treated as part of the security's market identity.

The addon does not read or preserve the manual UUID mappings used by earlier
versions. A newly purchased supported stock or ETF therefore needs no setup.
If an identity is missing, unsupported, conflicting, or not uniquely resolvable,
the addon fails closed and writes none of that sync round instead of guessing.

## Required Trading 212 access

Create an API key and secret for the correct live Stocks & Shares ISA. Enable
only the read-only areas used by the addon:

- Account data
- Personal portfolio / positions
- History: orders
- History: dividends
- History: transactions

Do not enable Equity Orders or any permission that can place, modify, or cancel
orders. The addon allowlists `GET` requests to `https://live.trading212.com`
only. Trading 212's current endpoint catalogue is documented in its
[Public API reference](https://docs.trading212.com/api).

## Install

1. Download `Trading-212-Sync-0.1.17.zip` from the latest GitHub Release. Do
   not use GitHub's automatically generated **Source code** archives as the
   Wealthfolio installation package.
2. In Wealthfolio, open **Settings > Add-ons > Install from file**.
3. Select the ZIP and review the requested host and SDK permissions.
4. Create or select a GBP securities account that is dedicated to the Trading
   212 ISA and uses transaction tracking.
5. Open the addon, select that account, enter the API key and API secret, and
   confirm that the credentials belong to the ISA.
6. Start the connection. The addon previews and imports the full available
   history, reconciles cash and positions, and enables the five-minute timer
   only after the first run is consistent.

Do not paste API credentials into an issue, commit, pull request, screenshot, or
chat. Revoke the key in Trading 212 if it may have been exposed.

## Runtime and safety model

- The timer runs only while Wealthfolio is open and the computer is awake.
- The addon follows only strictly validated Trading 212 pagination paths.
- Each first-page history request starts without a cursor; later requests use
  only a validated server-provided continuation path.
- A write-ahead marker protects uncertain interrupted imports.
- Unsupported standalone fees, transfers, corporate actions, incomplete data,
  or reconciliation differences pause synchronization for review.
- Dividends are recorded as the net cash credited by Trading 212 because its
  Public API does not provide enough information to reconstruct withholding tax
  safely.
- The addon never calls a Trading 212 order endpoint.

## Privacy and security

- API credentials are stored through Wealthfolio's Secrets API in the operating
  system keyring, not ordinary addon storage.
- Secrets are not written to logs.
- Release bundles and the public repository must not contain an API key, API
  secret, Trading 212 account identifier, Wealthfolio account identifier, asset
  UUID, exported activity data, local database, or generated diagnostic output.
- Before publishing a ZIP or GitHub release, inspect the archive contents and
  search the source tree for credentials and user-specific identifiers.
- Never post credentials or portfolio data in a GitHub issue or pull request.
  See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run type-check
pnpm test
pnpm bundle
pnpm verify:release
```

The versioned installation ZIP and `SHA256SUMS.txt` are written to `release/`.
Never add local credentials or portfolio exports to fixtures. Contributions
are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull
request.

## License

MIT

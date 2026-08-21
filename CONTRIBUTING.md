# Contributing

Thank you for helping improve Trading 212 Sync for Wealthfolio.

## Before opening an issue

- Confirm that the problem occurs with the latest release.
- Remove account identifiers, security UUIDs, transaction identifiers, and
  other personal portfolio data from logs and screenshots.
- Never include a Trading 212 API key or secret. Revoke a credential immediately
  if it may have been exposed.
- Use the private process in [SECURITY.md](SECURITY.md) for vulnerabilities.

## Development

Requirements:

- Node.js 20.19 or later in the 20.x line, or Node.js 22.12 or later
- pnpm 11.19.0
- Wealthfolio 3.6.2 or later for installation testing

Install and verify the project:

```bash
pnpm install --frozen-lockfile
pnpm type-check
pnpm test
pnpm bundle
pnpm verify:release
```

Before submitting a pull request, install the generated ZIP in a test
Wealthfolio account and verify that a first full-history sync and a second
idempotent sync both complete successfully.

## Pull requests

- Keep Trading 212 access read-only. Do not add order-placement, order-change,
  or order-cancellation capabilities.
- Declare only the Wealthfolio permissions and network hosts actually used.
- Add or update tests for behavior changes.
- Update `CHANGELOG.md` for user-visible changes.
- Keep all interface text and public documentation in English.
- Do not commit generated `dist/`, `release/`, local databases, portfolio
  exports, credentials, logs, or diagnostics.

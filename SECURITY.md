# Security Policy

## Supported versions

Security fixes are provided for the latest published release of Trading 212
Sync for Wealthfolio.

## Report a vulnerability

Use **Security > Report a vulnerability** in this GitHub repository. Do not
open a public issue for a security vulnerability and do not include a Trading
212 API key, API secret, account identifier, Wealthfolio UUID, portfolio
export, database, log, or screenshot containing financial information.

If a Trading 212 credential may have been exposed, revoke it in Trading 212
immediately and create a replacement with only the read-only scopes documented
in the README.

## Security model

- The add-on sends only allowlisted `GET` requests to
  `https://live.trading212.com`.
- It never calls an endpoint that can place, modify, or cancel an order.
- Credentials are stored and injected through Wealthfolio's Secrets API and
  are not written to ordinary add-on storage or logs.
- Ambiguous security identities, interrupted writes, and reconciliation
  differences fail closed and pause automatic synchronization.

This policy covers the add-on code. Questions about Wealthfolio or Trading 212
itself should be reported to the respective project or service.

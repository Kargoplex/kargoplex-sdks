# Changelog

All notable changes to the SDKs. Both packages share a version number and are released together.

## 0.1.2 - 2026-11-18

- A failed write (POST, PUT, PATCH, DELETE) is retried only when the connection never opened (connection refused or DNS failure). A write that failed after it was sent may already have been processed, so retrying it could create a second quote or job. Reads still retry on any network error.

## 0.1.1 - 2026-11-16

- First release through the release workflow. npm releases are staged and go live after a maintainer approves them on npmjs.com.
- TypeScript: trailing slashes are removed from `baseUrl` without a regular expression (CodeQL `js/polynomial-redos`).
- Built with TypeScript 7 (identical output to 5.9).

## 0.1.0 - 2026-11-16

- Published to npm by hand to set up the package; not published to PyPI.

- First release: TypeScript (`@kargoplex/sdk`) and Python (`kargoplex`) clients for the Kargoplex public API v1 (API document 1.1.0).
- Resources: parties, quotes, jobs, document requests, invoices.
- Retries with exponential backoff and full jitter on 429 (honours `Retry-After`) and network errors; on 5xx for GET only.
- `paginate()` helper for list operations.

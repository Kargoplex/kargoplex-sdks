# Changelog

All notable changes to the SDKs. Both packages share a version number and are released together.

## 0.1.0 - Unreleased

- First release: TypeScript (`@kargoplex/sdk`) and Python (`kargoplex`) clients for the Kargoplex public API v1 (API document 1.1.0).
- Resources: parties, quotes, jobs, document requests, invoices.
- Retries with exponential backoff and full jitter on 429 (honours `Retry-After`) and network errors; on 5xx for GET only.
- `paginate()` helper for list operations.

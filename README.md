# Kargoplex SDKs

Official TypeScript/JavaScript and Python clients for the [Kargoplex public API](https://kargoplex.com/developers): parties, quotes, jobs, document requests and invoices for your own company.

| Language | Package | Install |
|---|---|---|
| TypeScript / JavaScript (Node 18+) | `@kargoplex/sdk` | `npm i @kargoplex/sdk` |
| Python 3.9+ | `kargoplex` | `pip install kargoplex` |

Both have no runtime dependencies, and both are generated from one OpenAPI 3.1 document (`openapi.json`) plus a small hand-written layer for auth, retries, errors and pagination.

## Authentication

Create an API key in **Settings → Developer** in Kargoplex. Keys look like `kp_live_<prefix>_<secret>` and carry scopes (`parties:read`, `parties:write`, `quotes:read`, `quotes:write`, `jobs:read`, `jobs:write`, `documents:read`, `documents:write`, `invoices:read`). Give a key only the scopes it needs.

A key is a secret. Use it from a server or a job, **never in a browser or a mobile app**, and read it from an environment variable (the examples use `KARGOPLEX_API_KEY`). The SDK sends it as `Authorization: Bearer <key>`.

## Quick start: TypeScript

```ts
import { Kargoplex, KargoplexError } from "@kargoplex/sdk";

const client = new Kargoplex({ apiKey: process.env.KARGOPLEX_API_KEY! });

const page = await client.parties.list({ role: "CUSTOMER", limit: 20 });
console.log(page.total, page.items);

const quote = await client.quotes.create({ customerPartyId: "…", currency: "USD" });
await client.quotes.send(quote._id);
```

Options: `new Kargoplex({ apiKey, baseUrl, maxRetries = 3, timeoutMs = 30000, fetch })`. Resources: `client.parties`, `client.quotes`, `client.jobs`, `client.documentRequests`, `client.invoices`.

## Quick start: Python

```python
import os
from kargoplex import Kargoplex, KargoplexError

client = Kargoplex(os.environ["KARGOPLEX_API_KEY"])

page = client.parties.list({"role": "CUSTOMER", "limit": 20})
print(page["total"], page["items"])

quote = client.quotes.create({"customerPartyId": "…", "currency": "USD"})
client.quotes.send(quote["_id"])
```

Options: `Kargoplex(api_key, base_url=…, max_retries=3, timeout=30, transport=None)`. Resources: `client.parties`, `client.quotes`, `client.jobs`, `client.document_requests`, `client.invoices`. Methods use snake_case (`client.jobs.create_from_quote(quote_id)`); request bodies and query params keep the API's own field names.

More runnable code is in [`examples/`](examples).

## Operations

| Resource | Methods |
|---|---|
| parties | `list`, `create`, `get` |
| quotes | `list`, `create`, `get`, `send` |
| jobs | `list`, `createFromQuote`, `get` |
| documentRequests | `list`, `create`, `get` |
| invoices | `list`, `get` |

Every method returns the `data` of the response. Responses are untyped objects (`ApiObject`): the OpenAPI document describes requests precisely but not response fields, so see the API guide for those.

## Errors

Every API response is `{ success, data }` or `{ success: false, error, code }`. A failure throws `KargoplexError` with:

- `status`: the HTTP status, or `0` when no response arrived (`code` is then `NETWORK_ERROR` or `TIMEOUT`)
- `code`: for example `API_KEY_INVALID` (401), `API_KEY_SCOPE_REQUIRED` (403), `ENTITLEMENT_LIMIT_REACHED` (402, monthly quota used up)
- `message`: the API's `error` text
- `requestId` (`request_id` in Python): the `X-Request-Id` header. Quote it when you contact support.
- `detail`: validation detail on a 400

```ts
try {
  await client.parties.create({ name: "" });
} catch (err) {
  if (err instanceof KargoplexError && err.status === 400) console.error(err.detail);
}
```

## Retries and timeouts

| Failure | GET | POST |
|---|---|---|
| 429 | retried; waits `Retry-After` seconds (max 60) | retried |
| Network error | retried | retried |
| Timeout | retried | **not** retried |
| 5xx | retried | **not** retried |

Retries use exponential backoff with full jitter (up to 0.5 s, 1 s, 2 s, … capped at 8 s) and stop after `maxRetries` (default 3). A 429 means the request was refused, so re-sending it is safe. A 5xx or a timeout on a write may have been processed, so the SDK never re-sends it for you. A connection error before any response is retried for every method, because the request usually never arrived; if you cannot tolerate a duplicate in that rare case, set `maxRetries: 0` for write calls.

The default timeout is 30 s per attempt.

## Pagination

List operations take `page` and `limit` and return `{ items, total, page, limit }`. Document requests may return `rows` instead of `items`; the SDK handles both. `paginate()` fetches pages lazily and stops at `total`:

```ts
for await (const party of client.paginate(client.parties.list, { role: "CUSTOMER" })) { … }
```

```python
for party in client.paginate(client.parties.list, {"role": "CUSTOMER"}):
    ...
```

`pageItems(page)` (`page_items(page)` in Python) reads `items` or `rows` from a single page.

## Rate limits

Calls are limited **per key and per company per minute**, and each plan has a **monthly call quota**. Over the per-minute limit the API answers 429 with a `Retry-After` header, which the SDK honours. When the monthly quota is used up the API answers 402 `ENTITLEMENT_LIMIT_REACHED`; that is not retried. Responses carry `RateLimit` and `RateLimit-Policy` headers (remaining calls and window).

## Regenerating from the API spec

`openapi.json` is the source of truth and is published by the Kargoplex server. To update:

```bash
node scripts/sync-openapi.mjs                       # copies ../kargoplex-server/docs/public-api/openapi.json
node scripts/sync-openapi.mjs path/to/openapi.json  # or from another path
node scripts/generate.mjs                           # rewrites ts/src/generated.ts and python/kargoplex/_generated.py
node scripts/generate.mjs --check                   # exits 1 if the committed generated files differ (CI runs this)
```

The generator has no dependencies. Never edit `generated.ts` or `_generated.py` by hand. Client behaviour lives in `ts/src/client.ts` and `python/kargoplex/client.py`; keep the two in step.

## Development

```bash
cd ts && npm install && npm run build && npm test
cd python && PYTHONPATH=. python -m pytest
```

## Releasing

Both packages share one version. Bump `version` in `ts/package.json`, `python/pyproject.toml`, `VERSION` in `ts/src/client.ts` and `python/kargoplex/client.py`, then update `CHANGELOG.md`, merge, and push a tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The `Release` workflow runs on the tag, waits for a reviewer to approve the `release` environment, then publishes to npm (with provenance) and PyPI using trusted publishing (OIDC). No token is stored in the repository. One-time setup:

1. In the GitHub repo, create an environment named `release` with a required reviewer.
2. On npmjs.com, add a trusted publisher for `@kargoplex/sdk`: this repo, workflow `release.yml`, environment `release`.
3. On pypi.org, add a trusted publisher for `kargoplex`: this repo, workflow `release.yml`, environment `release`.

## Licence

MIT, see [LICENSE](LICENSE).

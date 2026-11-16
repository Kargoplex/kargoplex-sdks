"""Hand-written client layer: auth, retries, timeouts, errors, pagination."""
import json
import random
import socket
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Iterator, Mapping, Optional, Tuple
from urllib.parse import urlencode

from ._generated import (
    ApiObject,
    DocumentRequestsResource,
    InvoicesResource,
    JobsResource,
    Page,
    PartiesResource,
    QuotesResource,
)

VERSION = "0.1.1"
DEFAULT_BASE_URL = "https://server.kargoplex.com/kargoplex/api/public/v1"

_BASE_BACKOFF = 0.5
_MAX_BACKOFF = 8.0
_MAX_RETRY_AFTER = 60.0

# transport(method, url, headers, body, timeout) -> (status, response_headers, response_body)
# It raises TimeoutError on a timeout and another OSError (e.g. ConnectionError) on a network failure.
Transport = Callable[[str, str, Dict[str, str], Optional[bytes], float], Tuple[int, Mapping[str, str], bytes]]


class KargoplexError(Exception):
    """An API error, or a network failure (status 0)."""

    def __init__(
        self,
        message: str,
        status: int = 0,
        code: Optional[str] = None,
        request_id: Optional[str] = None,
        detail: Any = None,
        retry_after: Optional[float] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.request_id = request_id
        self.detail = detail
        self.retry_after = retry_after

    def __str__(self) -> str:
        bits = [str(self.status) if self.status else "network", self.code or "", self.message]
        return " ".join(b for b in bits if b)


def page_items(page: Page) -> list:
    """Items of a page, whether the API calls them `items` or `rows`."""
    items = page.get("items")
    if items is None:
        items = page.get("rows")
    return items or []


def _urllib_transport(method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float):
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers.items()), resp.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers.items()) if err.headers else {}, err.read()
    except urllib.error.URLError as err:
        if isinstance(err.reason, (socket.timeout, TimeoutError)):
            raise TimeoutError(str(err.reason)) from err
        raise ConnectionError(str(err.reason)) from err
    except (socket.timeout, TimeoutError) as err:
        raise TimeoutError(str(err)) from err


def _query_string(query: Optional[Mapping[str, Any]]) -> str:
    if not query:
        return ""
    pairs = []
    for key, value in query.items():
        if value is None:
            continue
        values = value if isinstance(value, (list, tuple)) else [value]
        for v in values:
            pairs.append((key, "true" if v is True else "false" if v is False else str(v)))
    return "?" + urlencode(pairs) if pairs else ""


class Kargoplex:
    """Kargoplex API client. Server-side only: never ship an API key to a browser."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        max_retries: int = 3,
        timeout: float = 30,
        transport: Optional[Transport] = None,
        sleep: Optional[Callable[[float], None]] = None,
    ) -> None:
        if not api_key:
            raise ValueError("Kargoplex: api_key is required")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._max_retries = max_retries
        self._timeout = timeout
        self._transport: Transport = transport or _urllib_transport
        self._sleep = sleep or time.sleep

        self.parties = PartiesResource(self._request)
        self.quotes = QuotesResource(self._request)
        self.jobs = JobsResource(self._request)
        self.document_requests = DocumentRequestsResource(self._request)
        self.invoices = InvoicesResource(self._request)

    def paginate(
        self,
        list_fn: Callable[..., Page],
        params: Optional[Mapping[str, Any]] = None,
    ) -> Iterator[ApiObject]:
        """Iterate every item of a list operation, fetching pages as needed.

        for party in client.paginate(client.parties.list, {"role": "CUSTOMER"}):
            ...
        """
        base = dict(params or {})
        page = int(base.get("page") or 1)
        while True:
            res = list_fn({**base, "page": page})
            items = page_items(res)
            yield from items
            limit = res.get("limit") or base.get("limit") or len(items)
            if not items:
                return
            total = res.get("total")
            current = res.get("page") or page
            if isinstance(total, int):
                if current * limit >= total:
                    return
            elif len(items) < limit:
                return
            page = current + 1

    def _backoff(self, attempt: int) -> float:
        return random.uniform(0, min(_MAX_BACKOFF, _BASE_BACKOFF * (2**attempt)))

    def _request(
        self,
        method: str,
        path: str,
        query: Optional[Mapping[str, Any]] = None,
        body: Any = None,
    ) -> Any:
        url = f"{self._base_url}{path}{_query_string(query)}"
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
            "User-Agent": f"kargoplex-sdk-python/{VERSION}",
        }
        data: Optional[bytes] = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        is_get = method == "GET"

        attempt = 0
        while True:
            can_retry = attempt < self._max_retries
            try:
                status, resp_headers, raw = self._transport(method, url, headers, data, self._timeout)
            except OSError as err:
                timed_out = isinstance(err, TimeoutError) or isinstance(err, socket.timeout)
                # A timed-out write may have been processed, so it is never re-sent.
                if can_retry and not (timed_out and not is_get):
                    self._sleep(self._backoff(attempt))
                    attempt += 1
                    continue
                raise KargoplexError(
                    f"Request timed out after {self._timeout}s" if timed_out else f"Network error: {err}",
                    status=0,
                    code="TIMEOUT" if timed_out else "NETWORK_ERROR",
                ) from err

            lowered = {str(k).lower(): v for k, v in (resp_headers or {}).items()}
            request_id = lowered.get("x-request-id")
            try:
                payload = json.loads(raw.decode("utf-8")) if raw else None
            except (ValueError, UnicodeDecodeError):
                payload = None
            if not isinstance(payload, dict):
                payload = None

            ok = 200 <= status < 300
            if ok and payload is not None and payload.get("success") is True:
                return payload.get("data")

            retry_after: Optional[float] = None
            header = lowered.get("retry-after")
            if header not in (None, ""):
                try:
                    retry_after = float(header)
                except ValueError:
                    retry_after = None

            if (status == 429 or (status >= 500 and is_get)) and can_retry:
                wait = min(retry_after, _MAX_RETRY_AFTER) if retry_after is not None else self._backoff(attempt)
                self._sleep(wait)
                attempt += 1
                continue

            message = (
                payload.get("error")
                if payload and isinstance(payload.get("error"), str) and payload.get("error")
                else ("Unexpected response from the API" if ok else f"HTTP {status}")
            )
            code = payload.get("code") if payload and isinstance(payload.get("code"), str) else None
            raise KargoplexError(
                message,
                status=status,
                code=code,
                request_id=request_id,
                detail=payload.get("detail") if payload else None,
                retry_after=retry_after,
            )

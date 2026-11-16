import json

import pytest

from kargoplex import Kargoplex, KargoplexError


def ok(data, headers=None):
    return 200, headers or {}, json.dumps({"success": True, "data": data}).encode()


def fail(status, body, headers=None):
    return status, headers or {}, json.dumps(body).encode()


class Fake:
    """Fake transport serving queued responses (or raising queued exceptions)."""

    def __init__(self, queue):
        self.queue = list(queue)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": headers, "body": body, "timeout": timeout})
        if not self.queue:
            raise AssertionError("fake transport queue empty")
        nxt = self.queue.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


def make(queue, **kw):
    fake = Fake(queue)
    sleeps = []
    client = Kargoplex("kp_live_test_secret", transport=fake, sleep=sleeps.append, **kw)
    return client, fake, sleeps


def test_sends_bearer_key_and_unwraps_data():
    client, fake, _ = make([ok({"items": [], "total": 0, "page": 1, "limit": 20})])
    res = client.parties.list({"q": "acme", "page": 2})
    assert res["total"] == 0
    call = fake.calls[0]
    assert call["headers"]["Authorization"] == "Bearer kp_live_test_secret"
    assert call["method"] == "GET"
    assert call["url"] == "https://server.kargoplex.com/kargoplex/api/public/v1/parties?q=acme&page=2"


def test_post_sends_json_body():
    client, fake, _ = make([ok({"_id": "1"})])
    client.parties.create({"name": "Acme"})
    call = fake.calls[0]
    assert call["method"] == "POST"
    assert call["headers"]["Content-Type"] == "application/json"
    assert json.loads(call["body"]) == {"name": "Acme"}


def test_retries_429_and_honours_retry_after():
    client, fake, sleeps = make(
        [fail(429, {"success": False, "error": "slow", "code": "RATE_LIMITED"}, {"Retry-After": "2"}), ok({"_id": "1"})]
    )
    assert client.quotes.get("abc") == {"_id": "1"}
    assert len(fake.calls) == 2
    assert sleeps == [2.0]


def test_retries_429_on_post():
    client, fake, _ = make([fail(429, {"success": False, "error": "x"}, {"Retry-After": "0"}), ok({"_id": "1"})])
    client.parties.create({"name": "Acme"})
    assert len(fake.calls) == 2


def test_gives_up_after_max_retries_on_429():
    body = {"success": False, "error": "Too many calls", "code": "RATE_LIMITED"}
    client, fake, _ = make(
        [fail(429, body, {"Retry-After": "1", "X-Request-Id": "req_9"}) for _ in range(3)], max_retries=2
    )
    with pytest.raises(KargoplexError) as exc:
        client.invoices.list()
    err = exc.value
    assert (err.status, err.code, err.request_id, err.retry_after) == (429, "RATE_LIMITED", "req_9", 1.0)
    assert len(fake.calls) == 3


def test_retries_5xx_on_get_with_backoff():
    client, fake, sleeps = make([fail(503, {"success": False, "error": "down"}), ok({"_id": "1"})])
    client.jobs.get("abc")
    assert len(fake.calls) == 2
    assert len(sleeps) == 1 and 0 <= sleeps[0] <= 0.5


def test_never_retries_post_5xx():
    client, fake, _ = make([fail(500, {"success": False, "error": "boom"}), ok({"_id": "1"})])
    with pytest.raises(KargoplexError) as exc:
        client.quotes.send("abc")
    assert exc.value.status == 500
    assert len(fake.calls) == 1


def test_retries_network_errors_including_post():
    client, fake, _ = make([ConnectionError("reset"), ok({"_id": "1"})])
    client.parties.create({"name": "Acme"})
    assert len(fake.calls) == 2


def test_network_error_surfaces_after_retries():
    client, _, _ = make([ConnectionError("down"), ConnectionError("down")], max_retries=1)
    with pytest.raises(KargoplexError) as exc:
        client.parties.get("a")
    assert exc.value.status == 0 and exc.value.code == "NETWORK_ERROR"


def test_timed_out_post_is_not_resent():
    client, fake, _ = make([TimeoutError("slow"), ok({"_id": "1"})])
    with pytest.raises(KargoplexError) as exc:
        client.parties.create({"name": "x"})
    assert exc.value.code == "TIMEOUT"
    assert len(fake.calls) == 1


def test_timeout_is_passed_to_transport():
    client, fake, _ = make([ok({})], timeout=5)
    client.parties.get("a")
    assert fake.calls[0]["timeout"] == 5


def test_error_mapping():
    client, _, _ = make(
        [
            fail(400, {"success": False, "error": "name: Required", "detail": {"name": "Required"}}, {"x-request-id": "req_1"}),
            fail(401, {"success": False, "error": "Invalid key", "code": "API_KEY_INVALID"}),
            (404, {}, b"<html>nope</html>"),
        ]
    )
    with pytest.raises(KargoplexError) as e1:
        client.parties.create({"name": ""})
    assert (e1.value.status, e1.value.message, e1.value.request_id, e1.value.detail) == (
        400,
        "name: Required",
        "req_1",
        {"name": "Required"},
    )
    with pytest.raises(KargoplexError) as e2:
        client.parties.get("x")
    assert (e2.value.status, e2.value.code) == (401, "API_KEY_INVALID")
    with pytest.raises(KargoplexError) as e3:
        client.parties.get("x")
    assert (e3.value.status, e3.value.message) == (404, "HTTP 404")


def test_path_params_are_encoded():
    client, fake, _ = make([ok({}), ok({})])
    client.parties.get("a/b c?d")
    client.jobs.create_from_quote("q#1")
    assert fake.calls[0]["url"].endswith("/parties/a%2Fb%20c%3Fd")
    assert fake.calls[1]["url"].endswith("/jobs/from-quote/q%231")
    assert fake.calls[1]["method"] == "POST"


def _page(n, count):
    return ok({"items": [{"n": f"{n}-{i}"} for i in range(count)], "total": 5, "page": n, "limit": 2})


def test_paginate_stops_at_total():
    client, fake, _ = make([_page(1, 2), _page(2, 2), _page(3, 1)])
    seen = [p["n"] for p in client.paginate(client.parties.list, {"limit": 2})]
    assert seen == ["1-0", "1-1", "2-0", "2-1", "3-0"]
    assert len(fake.calls) == 3
    assert "page=3" in fake.calls[2]["url"]


def test_paginate_handles_rows_and_empty():
    client, fake, _ = make([ok({"rows": [{"id": "a"}, {"id": "b"}], "total": 2, "page": 1, "limit": 50})])
    assert [r["id"] for r in client.paginate(client.document_requests.list)] == ["a", "b"]
    assert len(fake.calls) == 1

    empty, _, _ = make([ok({"items": [], "total": 0, "page": 1, "limit": 20})])
    assert list(empty.paginate(empty.invoices.list)) == []


def test_paginate_starts_from_params_page():
    client, fake, _ = make([ok({"items": [{"n": 1}], "total": 3, "page": 3, "limit": 1})])
    assert [r["n"] for r in client.paginate(client.jobs.list, {"page": 3, "limit": 1})] == [1]
    assert len(fake.calls) == 1


def test_api_key_required():
    with pytest.raises(ValueError):
        Kargoplex("")

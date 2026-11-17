import test from "node:test";
import assert from "node:assert/strict";
import { Kargoplex, KargoplexError } from "../dist/index.js";

const ok = (data, headers = {}) =>
  new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { "content-type": "application/json", ...headers } });
const fail = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Fake fetch that serves queued responses (or throws queued errors) and records calls. */
function fakeFetch(queue) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("fake fetch queue empty");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(url, init) : next;
  };
  fn.calls = calls;
  return fn;
}

function make(queue, extra = {}) {
  const sleeps = [];
  const fetch = fakeFetch(queue);
  const client = new Kargoplex({
    apiKey: "kp_live_test_secret",
    fetch,
    sleep: async (ms) => void sleeps.push(ms),
    ...extra,
  });
  return { client, fetch, sleeps };
}

test("sends the bearer key and unwraps data", async () => {
  const { client, fetch } = make([ok({ items: [], total: 0, page: 1, limit: 20 })]);
  const res = await client.parties.list({ q: "acme", page: 2 });
  assert.deepEqual(res, { items: [], total: 0, page: 1, limit: 20 });
  const { url, init } = fetch.calls[0];
  assert.equal(init.headers.Authorization, "Bearer kp_live_test_secret");
  assert.equal(init.method, "GET");
  assert.equal(url, "https://server.kargoplex.com/kargoplex/api/public/v1/parties?q=acme&page=2");
});

test("POST sends a JSON body", async () => {
  const { client, fetch } = make([ok({ _id: "1" })]);
  await client.parties.create({ name: "Acme" });
  assert.equal(fetch.calls[0].init.method, "POST");
  assert.equal(fetch.calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(fetch.calls[0].init.body, JSON.stringify({ name: "Acme" }));
});

test("retries 429 and honours Retry-After seconds", async () => {
  const { client, fetch, sleeps } = make([
    fail(429, { success: false, error: "slow down", code: "RATE_LIMITED" }, { "retry-after": "2" }),
    ok({ _id: "1" }),
  ]);
  const res = await client.quotes.get("abc");
  assert.deepEqual(res, { _id: "1" });
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
});

test("retries 429 on POST too", async () => {
  const { client, fetch } = make([fail(429, { success: false, error: "x" }, { "retry-after": "0" }), ok({ _id: "1" })]);
  await client.parties.create({ name: "Acme" });
  assert.equal(fetch.calls.length, 2);
});

test("gives up after maxRetries on 429 and throws KargoplexError", async () => {
  const body = { success: false, error: "Too many calls", code: "RATE_LIMITED" };
  const { client, fetch } = make(
    [1, 2, 3].map(() => fail(429, body, { "retry-after": "1", "x-request-id": "req_9" })),
    { maxRetries: 2 },
  );
  await assert.rejects(client.invoices.list(), (err) => {
    assert.ok(err instanceof KargoplexError);
    assert.equal(err.status, 429);
    assert.equal(err.code, "RATE_LIMITED");
    assert.equal(err.requestId, "req_9");
    assert.equal(err.retryAfter, 1);
    return true;
  });
  assert.equal(fetch.calls.length, 3);
});

test("retries 5xx on GET with backoff", async () => {
  const { client, fetch, sleeps } = make([fail(503, { success: false, error: "down" }), ok({ _id: "1" })]);
  await client.jobs.get("abc");
  assert.equal(fetch.calls.length, 2);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 0 && sleeps[0] <= 500);
});

test("never retries a POST that got a 5xx", async () => {
  const { client, fetch } = make([fail(500, { success: false, error: "boom" }), ok({ _id: "1" })]);
  await assert.rejects(client.quotes.send("abc"), (err) => err instanceof KargoplexError && err.status === 500);
  assert.equal(fetch.calls.length, 1);
});

test("retries network errors for GET", async () => {
  const { client, fetch } = make([new TypeError("fetch failed"), ok({ _id: "1" })]);
  await client.parties.get("a");
  assert.equal(fetch.calls.length, 2);
});

test("a POST is re-sent only when the connection never opened", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
  const retried = make([refused, ok({ _id: "1" })]);
  await retried.client.parties.create({ name: "Acme" });
  assert.equal(retried.fetch.calls.length, 2);

  const reset = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket"), { code: "ECONNRESET" }) });
  const once = make([reset, ok({ _id: "1" })]);
  await assert.rejects(once.client.parties.create({ name: "Acme" }), (err) => err instanceof KargoplexError && err.code === "NETWORK_ERROR");
  assert.equal(once.fetch.calls.length, 1);
});

test("network errors surface as KargoplexError after retries", async () => {
  const { client } = make([new TypeError("down"), new TypeError("down")], { maxRetries: 1 });
  await assert.rejects(client.parties.get("a"), (err) => err instanceof KargoplexError && err.status === 0 && err.code === "NETWORK_ERROR");
});

test("timeouts abort the request; a timed-out POST is not re-sent", async () => {
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const { client, fetch } = make([hang, ok({ _id: "1" })], { timeoutMs: 20 });
  await assert.rejects(client.parties.create({ name: "x" }), (err) => err instanceof KargoplexError && err.code === "TIMEOUT");
  assert.equal(fetch.calls.length, 1);
});

test("maps error bodies: status, code, message, request id, detail", async () => {
  const { client } = make([
    fail(400, { success: false, error: "name: Required", detail: { name: "Required" } }, { "x-request-id": "req_1" }),
    fail(401, { success: false, error: "Invalid, revoked or expired API key", code: "API_KEY_INVALID" }),
    new Response("<html>bad gateway</html>", { status: 404 }),
  ]);
  await assert.rejects(client.parties.create({ name: "" }), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.message, "name: Required");
    assert.equal(err.requestId, "req_1");
    assert.deepEqual(err.detail, { name: "Required" });
    return true;
  });
  await assert.rejects(client.parties.get("x"), (err) => err.status === 401 && err.code === "API_KEY_INVALID");
  await assert.rejects(client.parties.get("x"), (err) => err.status === 404 && err.message === "HTTP 404");
});

test("path params are URL-encoded", async () => {
  const { client, fetch } = make([ok({}), ok({})]);
  await client.parties.get("a/b c?d");
  await client.jobs.createFromQuote("q#1");
  assert.ok(fetch.calls[0].url.endsWith("/parties/a%2Fb%20c%3Fd"));
  assert.ok(fetch.calls[1].url.endsWith("/jobs/from-quote/q%231"));
  assert.equal(fetch.calls[1].init.method, "POST");
});

test("paginate walks pages and stops at total", async () => {
  const page = (n, count) => ok({ items: Array.from({ length: count }, (_, i) => ({ n: `${n}-${i}` })), total: 5, page: n, limit: 2 });
  const { client, fetch } = make([page(1, 2), page(2, 2), page(3, 1)]);
  const seen = [];
  for await (const p of client.paginate(client.parties.list, { limit: 2 })) seen.push(p.n);
  assert.deepEqual(seen, ["1-0", "1-1", "2-0", "2-1", "3-0"]);
  assert.equal(fetch.calls.length, 3);
  assert.ok(fetch.calls[2].url.includes("page=3"));
});

test("paginate handles `rows` (document requests) and an empty list", async () => {
  const { client, fetch } = make([ok({ rows: [{ id: "a" }, { id: "b" }], total: 2, page: 1, limit: 50 })]);
  const seen = [];
  for await (const r of client.paginate(client.documentRequests.list)) seen.push(r.id);
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(fetch.calls.length, 1);

  const empty = make([ok({ items: [], total: 0, page: 1, limit: 20 })]);
  const none = [];
  for await (const r of empty.client.paginate(empty.client.invoices.list)) none.push(r);
  assert.deepEqual(none, []);
});

test("paginate starts from params.page", async () => {
  const { client, fetch } = make([ok({ items: [{ n: 1 }], total: 3, page: 3, limit: 1 })]);
  const seen = [];
  for await (const r of client.paginate(client.jobs.list, { page: 3, limit: 1 })) seen.push(r.n);
  assert.deepEqual(seen, [1]);
  assert.equal(fetch.calls.length, 1);
});

test("apiKey is required", () => {
  assert.throws(() => new Kargoplex({}), /apiKey/);
});

test("trailing slashes on baseUrl are removed, and a long run of them is fast", async () => {
  const { client, fetch } = make([ok({ items: [], total: 0, page: 1, limit: 20 })], { baseUrl: "https://api.example.test/v1///" });
  await client.parties.list();
  assert.ok(fetch.calls[0].url.startsWith("https://api.example.test/v1/"));
  assert.ok(!fetch.calls[0].url.startsWith("https://api.example.test/v1//"));
  const started = Date.now();
  new Kargoplex({ apiKey: "k", fetch: async () => ok({}), baseUrl: "/".repeat(50000) + "x" });
  assert.ok(Date.now() - started < 200);
});

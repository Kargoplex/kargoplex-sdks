import {
  DocumentRequestsResource,
  InvoicesResource,
  JobsResource,
  PartiesResource,
  QuotesResource,
  type ApiObject,
  type Page,
  type RequestFn,
} from "./generated.js";

export const VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://server.kargoplex.com/kargoplex/api/public/v1";

const MAX_BACKOFF_MS = 8000;
const BASE_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;

export class KargoplexError extends Error {
  /** HTTP status, or 0 when no response arrived (network error or timeout). */
  readonly status: number;
  /** Machine-readable code from the API (for example `API_KEY_INVALID`), or an SDK code such as `NETWORK_ERROR`. */
  readonly code?: string;
  /** Value of the `X-Request-Id` response header, when present. Quote it to support. */
  readonly requestId?: string;
  /** Validation detail the API sends on a 400. */
  readonly detail?: unknown;
  /** Seconds from the `Retry-After` header, when present. */
  readonly retryAfter?: number;

  constructor(
    message: string,
    init: { status: number; code?: string; requestId?: string; detail?: unknown; retryAfter?: number; cause?: unknown },
  ) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "KargoplexError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.detail = init.detail;
    this.retryAfter = init.retryAfter;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface KargoplexOptions {
  /** Secret API key (`kp_live_...`). Server-side only. */
  apiKey: string;
  baseUrl?: string;
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** Per-attempt timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Replaces the backoff sleep. Meant for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Items of a page, whether the API calls them `items` or `rows`. */
export function pageItems(page: Page): ApiObject[] {
  return page.items ?? page.rows ?? [];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function buildQuery(query: object | undefined): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) sp.append(k, String(x));
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export class Kargoplex {
  readonly parties: PartiesResource;
  readonly quotes: QuotesResource;
  readonly jobs: JobsResource;
  readonly documentRequests: DocumentRequestsResource;
  readonly invoices: InvoicesResource;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: KargoplexOptions) {
    if (!options || !options.apiKey) throw new Error("Kargoplex: apiKey is required");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 30000;
    const f = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) throw new Error("Kargoplex: no fetch available; pass options.fetch or use Node 18+");
    this.fetchImpl = f;
    this.sleep = options.sleep ?? defaultSleep;

    const req: RequestFn = (method, path, opts) => this.request(method, path, opts);
    this.parties = new PartiesResource(req);
    this.quotes = new QuotesResource(req);
    this.jobs = new JobsResource(req);
    this.documentRequests = new DocumentRequestsResource(req);
    this.invoices = new InvoicesResource(req);
  }

  /**
   * Iterate every item of a list operation, fetching pages as needed.
   *
   *   for await (const party of client.paginate(client.parties.list, { role: "CUSTOMER" })) { ... }
   */
  async *paginate<P extends { page?: number; limit?: number }>(
    list: (params?: P) => Promise<Page>,
    params?: P,
  ): AsyncGenerator<ApiObject, void, undefined> {
    let page = params?.page ?? 1;
    for (;;) {
      const res = await list({ ...(params ?? {}), page } as P);
      const items = pageItems(res);
      for (const item of items) yield item;
      const limit = res.limit ?? params?.limit ?? items.length;
      if (items.length === 0) return;
      if (typeof res.total === "number") {
        if ((res.page ?? page) * limit >= res.total) return;
      } else if (items.length < limit) {
        return;
      }
      page = (res.page ?? page) + 1;
    }
  }

  private async request(method: string, path: string, opts?: { query?: object; body?: unknown }): Promise<any> {
    const url = `${this.baseUrl}${path}${buildQuery(opts?.query)}`;
    const hasBody = opts?.body !== undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": `kargoplex-sdk-js/${VERSION}`,
    };
    if (hasBody) headers["Content-Type"] = "application/json";
    const isGet = method === "GET";

    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.maxRetries;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: hasBody ? JSON.stringify(opts!.body) : undefined,
          signal: controller.signal,
        });
        text = await res.text();
      } catch (err) {
        const timedOut = controller.signal.aborted;
        // A timed-out write may have been processed, so it is never re-sent.
        if (canRetry && !(timedOut && !isGet)) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new KargoplexError(
          timedOut ? `Request timed out after ${this.timeoutMs}ms` : `Network error: ${(err as Error)?.message ?? String(err)}`,
          { status: 0, code: timedOut ? "TIMEOUT" : "NETWORK_ERROR", cause: err },
        );
      } finally {
        clearTimeout(timer);
      }

      const requestId = res.headers.get("x-request-id") ?? undefined;
      let json: any;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }

      if (res.ok && json && json.success === true) return json.data;

      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfter = retryAfterHeader !== null && retryAfterHeader !== "" && !Number.isNaN(Number(retryAfterHeader))
        ? Number(retryAfterHeader)
        : undefined;
      const retryable = res.status === 429 || (res.status >= 500 && isGet);
      if (retryable && canRetry) {
        const wait = retryAfter !== undefined ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : this.backoff(attempt);
        await this.sleep(wait);
        continue;
      }

      const message =
        (json && typeof json.error === "string" && json.error) ||
        (res.ok ? "Unexpected response from the API" : `HTTP ${res.status}`);
      throw new KargoplexError(message, {
        status: res.status,
        code: json && typeof json.code === "string" ? json.code : undefined,
        requestId,
        detail: json?.detail,
        retryAfter,
      });
    }
  }

  /** Exponential backoff with full jitter. */
  private backoff(attempt: number): number {
    const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    return Math.random() * ceiling;
  }
}

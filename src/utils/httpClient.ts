/**
 * Shared outbound HTTP client.
 *
 * Purpose: keep the backend from saturating the upstream providers (ESPN,
 * HockeyTech, NHL, Ligue Magnus) with redundant or unbounded traffic, without
 * ever changing *what* is stored in the database — the refresh crons keep
 * running exactly as before, they simply stop wasting requests.
 *
 * Three mechanisms, all of them transparent for callers:
 *
 * 1. **Hard timeout** — every request is aborted after `timeoutMs` (default
 *    15 s), so a hanging connection can never block a refresh forever.
 * 2. **In-flight de-duplication** — two concurrent calls with the same
 *    de-duplication key (method + URL + body by default) share a single
 *    network round-trip. This is what removes the duplicate bursts: the live
 *    score endpoint is polled by every client every 30 s, and several clients
 *    usually poll within the same second.
 * 3. **Concurrency cap + optional short-TTL cache** — at most
 *    `HTTP_MAX_CONCURRENT_REQUESTS` requests are in flight at any time; the
 *    others wait in a FIFO queue. A caller may also ask for a response to be
 *    reused for a few seconds (`cacheTtlMs`), which is enough to collapse the
 *    scoreboard polling of many clients into one upstream call.
 */

/** Maximum number of outbound requests running at the same time. */
export const HTTP_MAX_CONCURRENT_REQUESTS =
  Number.parseInt(process.env.HTTP_MAX_CONCURRENT_REQUESTS ?? '6', 10) || 6;

/** Default hard timeout of a single outbound request. */
export const HTTP_DEFAULT_TIMEOUT_MS = 15000;

/** A snapshot of a response, safe to cache and to share between callers. */
export type HttpResponseSnapshot = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  /**
   * The already-parsed JSON payload, when the upstream response exposed one.
   * Kept so `json()` returns the very same object instead of a re-parsed copy.
   */
  parsed?: any;
};

/**
 * Header names read explicitly when the upstream response only exposes a
 * `headers.get()` accessor (the test doubles used across the codebase).
 */
const KNOWN_HEADERS = ['content-type', 'retry-after', 'cache-control'];

/**
 * Reads the headers of a response, supporting both the real `Headers` object
 * (which exposes `forEach`) and the plain `{ get(name) }` doubles.
 */
const readHeaders = (headers: any): Record<string, string> => {
  const result: Record<string, string> = {};
  if (!headers) return result;

  if (typeof headers.forEach === 'function') {
    headers.forEach((value: string, key: string) => {
      result[String(key).toLowerCase()] = value;
    });
    return result;
  }

  if (typeof headers.get === 'function') {
    for (const name of KNOWN_HEADERS) {
      const value = headers.get(name);
      if (value !== null && value !== undefined) result[name] = value;
    }
    return result;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') result[key.toLowerCase()] = value;
  }
  return result;
};

/**
 * Response handed back to callers. It mimics the subset of the WHATWG
 * `Response` interface the codebase relies on (`ok`, `status`, `headers.get`,
 * `json()`, `text()`), but the body is read eagerly once so the response can
 * be cached and shared safely.
 */
export class HttpResponse {
  constructor(private readonly snapshot: HttpResponseSnapshot) {}

  get ok(): boolean {
    return this.snapshot.ok;
  }

  get status(): number {
    return this.snapshot.status;
  }

  get statusText(): string {
    return this.snapshot.statusText;
  }

  get headers(): { get(name: string): string | null } {
    const headers = this.snapshot.headers;
    return {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    };
  }

  async text(): Promise<string> {
    return this.snapshot.body;
  }

  async json(): Promise<any> {
    if (this.snapshot.parsed !== undefined) return this.snapshot.parsed;
    if (this.snapshot.body === '') return null;
    return JSON.parse(this.snapshot.body);
  }
}

export type HttpRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Hard timeout of the request. Defaults to `HTTP_DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Key used to de-duplicate concurrent requests and to share the cached
   * response. Defaults to `method + ' ' + url + ' ' + body`.
   */
  dedupeKey?: string;
  /**
   * Reuse the response for that many milliseconds. `0` (default) disables the
   * cache; the de-duplication of concurrent calls still applies.
   */
  cacheTtlMs?: number;
  /**
   * Number of extra attempts when the request fails (network error or
   * non-2xx status). The whole retry sequence is a single shared promise, so
   * concurrent callers de-duplicate the retries too, not only the first try.
   */
  retries?: number;
  /** Delay before the first retry; doubled for each further attempt. */
  retryDelayMs?: number;
  /**
   * Retry also when the upstream answers a non-2xx status. Disabled by
   * default: most callers already handle a specific status themselves (ESPN
   * treats 403/429 as a soft rate-limit and backs off on its own).
   */
  retryOnHttpError?: boolean;
  /** External cancellation (e.g. an aborted HTTP request from the client). */
  signal?: AbortSignal;
};

type CacheEntry = {
  expiresAt: number;
  response: HttpResponse;
};

const inFlight = new Map<string, Promise<HttpResponse>>();
const responseCache = new Map<string, CacheEntry>();

/** FIFO queue of pending requests, waiting for a free concurrency slot. */
let activeRequests = 0;
const waitingQueue: (() => void)[] = [];

const releaseSlot = (): void => {
  activeRequests -= 1;
  const next = waitingQueue.shift();
  if (next) next();
};

const acquireSlot = async (): Promise<void> => {
  if (activeRequests < HTTP_MAX_CONCURRENT_REQUESTS) {
    activeRequests += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    waitingQueue.push(() => {
      activeRequests += 1;
      resolve();
    });
  });
};

const buildDedupeKey = (url: string, options: HttpRequestOptions): string => {
  if (options.dedupeKey) return options.dedupeKey;
  const method = (options.method ?? 'GET').toUpperCase();
  return `${method} ${url} ${options.body ?? ''}`;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });

const readSnapshot = async (response: any): Promise<HttpResponseSnapshot> => {
  const headers = readHeaders(response.headers);
  // Real `Response` objects expose `text()`. The test doubles used across the
  // codebase only expose `json()`, so fall back to it and re-serialise.
  let body: string;
  let parsed: any;
  if (typeof response.text === 'function') {
    body = await response.text();
  } else if (typeof response.json === 'function') {
    parsed = await response.json();
    body = JSON.stringify(parsed);
  } else {
    body = '';
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText ?? '',
    headers,
    body,
    parsed,
  };
};

/**
 * Performs one raw request, with the timeout applied. The body is read
 * eagerly so the result can be cached and shared.
 */
const performSingleRequest = async (
  url: string,
  options: HttpRequestOptions,
): Promise<HttpResponse> => {
  const timeoutMs = options.timeoutMs ?? HTTP_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let externalAbortListener: (() => void) | null = null;
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      externalAbortListener = () => controller.abort();
      options.signal.addEventListener('abort', externalAbortListener);
    }
  }

  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    const snapshot = await readSnapshot(response);
    return new HttpResponse(snapshot);
  } finally {
    clearTimeout(timeout);
    timeout.unref();
    if (externalAbortListener && options.signal) {
      options.signal.removeEventListener('abort', externalAbortListener);
    }
  }
};

/**
 * Performs the request, retrying on failure when asked to. The retries stay
 * inside the shared promise, so a burst of concurrent callers triggers a
 * single sequence of upstream calls instead of one sequence per caller.
 */
const performRequest = async (
  url: string,
  options: HttpRequestOptions,
): Promise<HttpResponse> => {
  const retries = Math.max(0, options.retries ?? 0);
  const retryDelayMs = options.retryDelayMs ?? 500;
  let delay = retryDelayMs;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      await sleep(delay);
      delay *= 2;
    }
    try {
      const response = await performSingleRequest(url, options);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status} for ${url}`);
      if (attempt === retries || !options.retryOnHttpError) return response;
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Request failed for ${url}`);
};

/**
 * Performs an HTTP request through the shared client: timeout, de-duplication
 * of concurrent identical calls, concurrency cap and optional short-TTL cache.
 */
export const httpRequest = async (
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse> => {
  const key = buildDedupeKey(url, options);
  const ttl = options.cacheTtlMs ?? 0;

  if (ttl > 0) {
    const cached = responseCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.response;
    }
    if (cached) responseCache.delete(key);
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = (async () => {
    await acquireSlot();
    try {
      const response = await performRequest(url, options);
      if (ttl > 0) {
        responseCache.set(key, {
          expiresAt: Date.now() + ttl,
          response,
        });
      }
      return response;
    } finally {
      inFlight.delete(key);
      releaseSlot();
    }
  })();

  inFlight.set(key, request);
  return request;
};

/**
 * Clears the short-TTL response cache. Only needed by the tests, or when a
 * caller wants to force a fresh upstream call.
 */
export const clearHttpResponseCache = (): void => {
  responseCache.clear();
};

/** Snapshot of the client's internal state (exposed for the tests). */
export const getHttpStats = (): {
  inFlight: number;
  cached: number;
  active: number;
  queued: number;
} => ({
  inFlight: inFlight.size,
  cached: responseCache.size,
  active: activeRequests,
  queued: waitingQueue.length,
});

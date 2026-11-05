# File: `backend/src/utils/httpClient.ts`

## Purpose

Shared outbound HTTP client used by every data-fetch provider (ESPN, HockeyTech/NHL/PWHL, Ligue Magnus scraping). Its goal is to **reduce unnecessary network calls to upstream providers** without changing *what* is stored in the database — the refresh crons keep running exactly as before, they simply stop wasting requests.

## Key Features

- **Hard timeout** — every request is aborted after `timeoutMs` (default 15 s, `HTTP_DEFAULT_TIMEOUT_MS`), so a hanging connection can never block a refresh forever.
- **In-flight de-duplication** — two concurrent calls with the same de-duplication key (method + URL + body by default, overridable via `dedupeKey`) share a single network round-trip. This collapses duplicate bursts: several clients polling the live scores within the same second, or the same team schedule fetched twice during one refresh, trigger one upstream call instead of one per caller.
- **Concurrency cap** — at most `HTTP_MAX_CONCURRENT_REQUESTS` (default 6, overridable via the `HTTP_MAX_CONCURRENT_REQUESTS` env var) requests run in parallel; the rest wait in a FIFO queue.
- **Optional short-TTL cache** — a caller may set `cacheTtlMs` (e.g. 15 s) so the response is reused for that window; concurrent callers within the TTL get the cached response with zero upstream traffic. The live-score endpoints use this (15 s TTL).
- **Built-in retries** — `retries` + `retryDelayMs` (exponential backoff) run inside the shared promise, so a burst of concurrent callers triggers a single sequence of upstream calls instead of one sequence per caller. `retryOnHttpError` is off by default (callers such as ESPN handle 403/429 themselves).
- **External cancellation** — an `AbortSignal` can be passed to abort an in-flight request (e.g. when the caller gives up).

## State Variables

None at module level beyond the internal maps/queue:

- `inFlight` (`Map<string, Promise<HttpResponse>>`) — shared promises keyed by de-duplication key; enables de-duplication of concurrent identical calls.
- `responseCache` (`Map<string, CacheEntry>`) — short-TTL cache of responses.
- `activeRequests` / `waitingQueue` — concurrency cap enforcement (FIFO).

## Key Functions

### `httpRequest(url, options) -> Promise<HttpResponse>`

Performs an HTTP request through the shared client: timeout, de-duplication, concurrency cap, optional cache, retries. Returns an `HttpResponse` whose body is read eagerly once, so it can be cached and shared safely.

`HttpRequestOptions` fields:
- `method` (default `GET`), `headers`, `body`
- `timeoutMs` (default `HTTP_DEFAULT_TIMEOUT_MS` = 15000)
- `dedupeKey` (default `method + ' ' + url + ' ' + body`)
- `cacheTtlMs` (default `0` = disabled)
- `retries` (default `0`), `retryDelayMs` (default `500`, doubled each attempt)
- `retryOnHttpError` (default `false`)
- `signal` (`AbortSignal`)

### `HttpResponse` class

Mimics the `Response` subset the codebase relies on: `ok`, `status`, `statusText`, `headers.get(name)`, `json()`, `text()`. `json()` returns the already-parsed object when one was provided (test doubles), otherwise parses the eagerly-read body.

### `clearHttpResponseCache() -> void`

Clears the short-TTL response cache. Used by tests and by callers that want to force a fresh upstream call.

### `getHttpStats() -> { inFlight, cached, active, queued }`

Snapshot of the client's internal state, exposed for tests.

## Data Flow

```
caller (espnAllData / hockeyData / scrappingData)
      └─ httpRequest(url, { retries, cacheTtlMs, ... })
            ├─ responseCache hit (TTL not expired) → return cached
            ├─ inFlight hit (same key) → return shared promise
            └─ acquire concurrency slot → performSingleRequest (fetch + timeout)
                  ├─ retry on failure (up to `retries`, exponential backoff)
                  └─ store in inFlight + (if TTL) responseCache → return
```

All three providers go through this client, so their concurrent/fan-out calls share upstream round-trips and are bounded in concurrency.

## Providers Using It

- `backend/src/utils/fetchData/espnAllData.ts` — `fetchWithRetry()` now delegates to `httpRequest()`; `getESPNGameScore()` uses a 15 s cache TTL for live scores.
- `backend/src/utils/fetchData/hockeyData.ts` — all NHL / HockeyTech / PWHL fetches go through a local `hockeyFetch()` wrapper (15 s timeout, 1 retry); the live PWHL feed uses a 15 s cache TTL.
- `backend/src/utils/fetchData/scrappingData.ts` — `fetchWithTimeout()` now delegates to `httpRequest()`.

## Crons / Data Updates

**Untouched.** The refresh crons (`CronJobService`, `GameService.getLeagueGames()`) keep running on the same schedule and persist the same games; they simply stop issuing duplicate or unbounded upstream requests.

import {
  clearHttpResponseCache,
  getHttpStats,
  httpRequest,
  HTTP_MAX_CONCURRENT_REQUESTS,
} from './httpClient';

type FetchMock = jest.Mock<Promise<any>, [string, any]>;

const makeResponse = (body: string, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  headers: new Map<string, string>([['content-type', 'application/json']]),
  text: async () => body,
});

describe('httpClient', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    clearHttpResponseCache();
    fetchMock = jest.fn(async () =>
      makeResponse('{"ok":true}'),
    ) as unknown as FetchMock;
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the parsed body of a successful response', async () => {
    const response = await httpRequest('https://example.com/a');
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates concurrent identical requests into a single call', async () => {
    let resolveFetch: (value: any) => void = () => undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const first = httpRequest('https://example.com/same');
    const second = httpRequest('https://example.com/same');
    const third = httpRequest('https://example.com/same');

    // Let the shared request actually reach the network layer before
    // answering it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveFetch(makeResponse('{"shared":true}'));

    const [a, b, c] = await Promise.all([first, second, third]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await a.json()).toEqual({ shared: true });
    expect(await b.json()).toEqual({ shared: true });
    expect(await c.json()).toEqual({ shared: true });
  });

  it('does not de-duplicate requests with different URLs', async () => {
    await Promise.all([
      httpRequest('https://example.com/a'),
      httpRequest('https://example.com/b'),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reuses the cached response within the TTL', async () => {
    await httpRequest('https://example.com/cached', { cacheTtlMs: 5000 });
    await httpRequest('https://example.com/cached', { cacheTtlMs: 5000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the TTL has expired', async () => {
    await httpRequest('https://example.com/ttl', { cacheTtlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await httpRequest('https://example.com/ttl', { cacheTtlMs: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache when the TTL is disabled', async () => {
    await httpRequest('https://example.com/nocache');
    await httpRequest('https://example.com/nocache');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never runs more requests at once than the concurrency cap', async () => {
    let peak = 0;
    let running = 0;
    fetchMock.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return makeResponse('{}');
    });

    const urls = Array.from(
      { length: HTTP_MAX_CONCURRENT_REQUESTS * 3 },
      (_, index) => `https://example.com/page-${index}`,
    );
    await Promise.all(urls.map((url) => httpRequest(url)));

    expect(peak).toBeLessThanOrEqual(HTTP_MAX_CONCURRENT_REQUESTS);
    expect(fetchMock).toHaveBeenCalledTimes(urls.length);
  });

  it('retries a failed request and returns the successful response', async () => {
    fetchMock
      .mockImplementationOnce(async () => {
        throw new Error('network down');
      })
      .mockImplementationOnce(async () => makeResponse('{"retried":true}'));

    const response = await httpRequest('https://example.com/retry', {
      retries: 1,
      retryDelayMs: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual({ retried: true });
  });

  it('shares the retry sequence between concurrent callers', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('network down');
    });

    const results = await Promise.allSettled([
      httpRequest('https://example.com/shared-retry', {
        retries: 1,
        retryDelayMs: 1,
      }),
      httpRequest('https://example.com/shared-retry', {
        retries: 1,
        retryDelayMs: 1,
      }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
  });

  it('returns the last error response when every attempt fails', async () => {
    fetchMock.mockImplementation(async () => makeResponse('nope', 500));

    const response = await httpRequest('https://example.com/ko', {
      retries: 1,
      retryDelayMs: 1,
    });

    expect(response.ok).toBe(false);
    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts the request when the timeout is reached', async () => {
    fetchMock.mockImplementation(
      (_url, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );

    await expect(
      httpRequest('https://example.com/timeout', { timeoutMs: 10 }),
    ).rejects.toThrow('aborted');
  });

  it('cleans up its in-flight state once a request settles', async () => {
    await httpRequest('https://example.com/done');
    const stats = getHttpStats();
    expect(stats.inFlight).toBe(0);
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
  });
});

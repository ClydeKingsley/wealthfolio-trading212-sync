import assert from 'node:assert/strict';
import type { AddonContext, NetworkRequest, NetworkResponse } from '@wealthfolio/addon-sdk';
import {
  extractSafeValidationDetail,
  Trading212Api,
  Trading212ApiError,
} from '../src/lib/trading212-api';

Object.assign(globalThis, {
  window: {
    setTimeout(callback: () => void) {
      callback();
      return 1;
    },
  },
});

function mockContext(
  responder: (request: NetworkRequest) => NetworkResponse | Promise<NetworkResponse>,
): AddonContext {
  return {
    api: {
      network: {
        request: responder,
      },
    },
  } as unknown as AddonContext;
}

{
  const originalDateNow = Date.now;
  const originalSetTimeout = window.setTimeout;
  let now = 1_000_000;
  const summaryRequestTimes: number[] = [];
  const historyRequestPaths: string[] = [];

  Date.now = () => now;
  window.setTimeout = ((callback: () => void, milliseconds = 0) => {
    now += milliseconds;
    callback();
    return 1;
  }) as typeof window.setTimeout;

  try {
    const summaryApi = new Trading212Api(
      mockContext(() => {
        summaryRequestTimes.push(Date.now());
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ id: 1, currency: 'GBP', cash: {}, investments: {} }),
        };
      }),
    );
    await Promise.all([
      summaryApi.getAccountSummary(),
      summaryApi.getAccountSummary(),
      summaryApi.getAccountSummary(),
    ]);
    assert.deepEqual(summaryRequestTimes, [1_000_000, 1_005_100, 1_010_200]);

    let transportAttempts = 0;
    const retryApi = new Trading212Api(
      mockContext(() => {
        transportAttempts += 1;
        if (transportAttempts === 1) {
          throw new Error('transient transport failure');
        }
        return { status: 200, headers: {}, body: '[]' };
      }),
    );
    assert.deepEqual(await retryApi.getPositions(), []);
    assert.equal(transportAttempts, 2);

    let deterministicAttempts = 0;
    const oversizedApi = new Trading212Api(
      mockContext(() => {
        deterministicAttempts += 1;
        throw new Error('Addon network response body is too large');
      }),
    );
    await assert.rejects(
      () => oversizedApi.getPositions(),
      /exceeded Wealthfolio's addon network size limit/,
    );
    assert.equal(deterministicAttempts, 1);

    const historyApi = new Trading212Api(
      mockContext((request) => {
        historyRequestPaths.push(new URL(request.url).pathname);
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ items: [], nextPagePath: null }),
        };
      }),
    );
    await historyApi.getHistory('orders');

    const pendingTimers: Array<{ callback: () => void; milliseconds: number }> = [];
    window.setTimeout = ((callback: () => void, milliseconds = 0) => {
      pendingTimers.push({ callback, milliseconds });
      return 1;
    }) as typeof window.setTimeout;

    const waitingOrder = historyApi.getHistory('orders');
    const independentDividend = historyApi.getHistory('dividends');
    const independentTransaction = historyApi.getHistory('transactions');
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    assert.equal(
      historyRequestPaths.filter((path) => path.endsWith('/orders')).length,
      1,
    );
    assert.equal(
      historyRequestPaths.filter((path) => path.endsWith('/dividends')).length,
      1,
    );
    assert.equal(
      historyRequestPaths.filter((path) => path.endsWith('/transactions')).length,
      1,
    );
    assert.deepEqual(
      pendingTimers.map((timer) => timer.milliseconds),
      [10_500],
    );

    now += pendingTimers[0]!.milliseconds;
    pendingTimers[0]!.callback();
    await Promise.all([waitingOrder, independentDividend, independentTransaction]);
    assert.equal(
      historyRequestPaths.filter((path) => path.endsWith('/orders')).length,
      2,
    );
  } finally {
    Date.now = originalDateNow;
    window.setTimeout = originalSetTimeout;
  }
}

{
  const requests: NetworkRequest[] = [];
  const api = new Trading212Api(
    mockContext((request) => {
      requests.push(request);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ items: [], nextPagePath: null }),
      };
    }),
  );
  await api.getHistory('transactions');
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    'https://live.trading212.com/api/v0/equity/history/transactions?limit=50',
  );
  assert.equal(new URL(requests[0]!.url).searchParams.has('time'), false);
  assert.equal(new URL(requests[0]!.url).searchParams.has('cursor'), false);
}

{
  const paginationVariants = [
    '/api/v0/equity/history/transactions?cursor=opaque%2Ftoken&time=2026-07-31T12%3A00%3A00Z&limit=50',
    'https://live.trading212.com/api/v0/equity/history/transactions?cursor=opaque%2Ftoken&time=2026-07-31T12%3A00%3A00Z&limit=50',
    '/api/v0/equity/history/transactions/?cursor=opaque%2Ftoken&time=2026-07-31T12%3A00%3A00Z&limit=50',
    '?cursor=opaque%2Ftoken&time=2026-07-31T12%3A00%3A00Z&limit=50',
    'transactions?cursor=opaque%2Ftoken&time=2026-07-31T12%3A00%3A00Z&limit=50',
    'limit=50&cursor=opaque%2Ftoken&time=2026-07-31T12%3A00%3A00Z',
    '/api/v0/equity/history/orders?limit=50&cursor=opaque%2Ftoken&time=2026-07-31T12%3A00%3A00Z',
    'https://live.trading212.com/api/v0/equity/history/orders?cursor=opaque%2Ftoken&time=2026-07-31T12%3A00%3A00Z&limit=50',
  ];

  for (const nextPagePath of paginationVariants) {
    const requests: NetworkRequest[] = [];
    const api = new Trading212Api(
      mockContext((request) => {
        requests.push(request);
        return {
          status: 200,
          headers: {},
          body: JSON.stringify(
            requests.length === 1
              ? {
                  items: [{ type: 'DEPOSIT', dateTime: '2026-07-31T13:00:00Z' }],
                  nextPagePath,
                }
              : {
                  items: [{ type: 'FEE', dateTime: '2026-07-31T12:00:00Z' }],
                  nextPagePath: null,
                },
          ),
        };
      }),
    );

    const items = await api.getHistory('transactions');
    assert.equal(items.length, 2);
    assert.equal(requests.length, 2);
    const firstUrl = new URL(requests[0]!.url);
    assert.equal(firstUrl.searchParams.has('time'), false);
    assert.equal(firstUrl.searchParams.has('cursor'), false);
    assert.equal(requests[1]?.method, 'GET');
    const secondUrl = new URL(requests[1]!.url);
    assert.equal(secondUrl.origin, 'https://live.trading212.com');
    assert.equal(secondUrl.pathname, '/api/v0/equity/history/transactions');
    assert.equal(secondUrl.searchParams.get('cursor'), 'opaque/token');
    assert.equal(secondUrl.searchParams.get('time'), '2026-07-31T12:00:00Z');
  }
}

{
  const rejectedPaginationPaths = [
    'https://evil.example/api/v0/equity/history/transactions?cursor=1',
    '//evil.example/api/v0/equity/history/transactions?cursor=1',
    'http://live.trading212.com/api/v0/equity/history/transactions?cursor=1',
    'https://user@live.trading212.com/api/v0/equity/history/transactions?cursor=1',
    '/api/v0/equity/history/orders?cursor=1',
    '/api/v0/equity/history/transactions/1?cursor=1',
    '/api/v0/equity/history%2Ftransactions?cursor=1',
    '/api/v0/equity/history/../history/transactions?cursor=1',
    '/api/v0/equity/history/transactions?cursor=1#fragment',
    '/api/v0/equity/history/transactions',
    '/api/v0/equity/history/transactions?limit=50',
    '/api/v0/equity/history/transactions?cursor=1&limit=50',
    '/api/v0/equity/history/transactions?time=2026-07-31T12%3A00%3A00Z&limit=50',
    '/api/v0/equity/history/transactions?cursor=1&cursor=2&time=2026-07-31T12%3A00%3A00Z',
    '/api/v0/equity/history/transactions?cursor=1&time=2026-07-31T12%3A00%3A00Z&time=2026-07-31T11%3A00%3A00Z',
    '/api/v0/equity/history/transactions?cursor=1&time=not-a-date',
    '/api/v0/equity/history/transactions?cursor=1&time=2026-02-30T12%3A00%3A00Z',
    '/api/v0/equity/history/transactions?cursor=1&time=2026-07-31T12%3A00%3A00Z&limit=0',
    '/api/v0/equity/history/transactions?cursor=1&time=2026-07-31T12%3A00%3A00Z&limit=51',
    '/api/v0/equity/history/transactions?cursor=1&time=2026-07-31T12%3A00%3A00Z&limit=1.5',
    '/api/v0/equity/history/transactions?cursor=1&time=2026-07-31T12%3A00%3A00Z&limit=20&limit=50',
    '/api/v0/equity/history/transactions?cursor=1&time=2026-07-31T12%3A00%3A00Z&extra=1',
    '/api/v0/equity/history/dividends?cursor=1&time=2026-07-31T12%3A00%3A00Z&limit=50',
    'limit=50&cursor=1&time=2026-07-31T12%3A00%3A00Z&unknown=1',
    '/api/v0/equity/history/transactions\\?cursor=1&time=2026-07-31T12%3A00%3A00Z',
    '/api/v0/equity/history/transactions?cursor=1\u0001&time=2026-07-31T12%3A00%3A00Z',
    ' /api/v0/equity/history/transactions?cursor=1',
  ];

  for (const nextPagePath of rejectedPaginationPaths) {
    let calls = 0;
    const api = new Trading212Api(
      mockContext(() => {
        calls += 1;
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ items: [], nextPagePath }),
        };
      }),
    );
    await assert.rejects(
      () => api.getHistory('transactions'),
      /unsafe pagination path for transactions/,
    );
    assert.equal(calls, 1);
  }
}

{
  const api = new Trading212Api(
    mockContext(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ items: [], nextPagePath: '' }),
    })),
  );
  await assert.rejects(
    () => api.getHistory('transactions'),
    /malformed transactions pagination data/,
  );
}

{
  const secretCursor = 'cursor-value-must-not-appear';
  const secretPathSegment = 'path-value-must-not-appear';
  const api = new Trading212Api(
    mockContext(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        items: [],
        nextPagePath: `/api/v0/equity/history/${secretPathSegment}?cursor=${secretCursor}&time=2026-07-31T12%3A00%3A00Z`,
      }),
    })),
  );
  await assert.rejects(
    () => api.getHistory('transactions'),
    (error: unknown) =>
      error instanceof Trading212ApiError &&
      !error.message.includes(secretCursor) &&
      !error.message.includes(secretPathSegment) &&
      error.message.includes('path=/api/v0/equity/history/[opaque]'),
  );
}

{
  let calls = 0;
  const api = new Trading212Api(
    mockContext(() => {
      calls += 1;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          items: [],
          nextPagePath:
            calls === 1
              ? '/api/v0/equity/history/transactions?cursor=equivalent&time=2026-07-31T12%3A00%3A00Z&limit=50'
              : '/api/v0/equity/history/transactions?limit=50&time=2026-07-31T12%3A00%3A00Z&cursor=equivalent',
        }),
      };
    }),
  );
  await assert.rejects(
    () => api.getHistory('transactions'),
    /pagination repeated a cursor/,
  );
  assert.equal(calls, 2);
}

{
  const repeatedPath =
    '/api/v0/equity/history/transactions?cursor=repeat&time=2026-07-31T12%3A00%3A00Z&limit=50';
  let calls = 0;
  const api = new Trading212Api(
    mockContext(() => {
      calls += 1;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ items: [], nextPagePath: repeatedPath }),
      };
    }),
  );
  await assert.rejects(
    () => api.getHistory('transactions'),
    /pagination repeated a cursor/,
  );
  assert.equal(calls, 2);
}

{
  let calls = 0;
  const api = new Trading212Api(
    mockContext(() => {
      calls += 1;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(
          calls === 1
            ? {
                items: [
                  { type: 'DEPOSIT', dateTime: '2026-07-31T13:00:00Z' },
                  { type: 'DEPOSIT' },
                ],
                nextPagePath:
                  'limit=50&cursor=missing-date&time=2026-07-30T23%3A00%3A00Z',
              }
            : {
                items: [{ type: 'DEPOSIT', dateTime: '2026-07-30T23:00:00Z' }],
                nextPagePath: null,
              },
        ),
      };
    }),
  );
  const items = await api.getHistory('transactions');
  assert.equal(items.length, 3);
  assert.equal(calls, 2);
}

{
  let calls = 0;
  const api = new Trading212Api(
    mockContext(() => {
      calls += 1;
      const cursorTime = new Date(Date.UTC(2026, 6, 31, 12, 0, calls)).toISOString();
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          items: [],
          nextPagePath: `limit=50&cursor=page-${calls}&time=${encodeURIComponent(cursorTime)}`,
        }),
      };
    }),
  );
  await assert.rejects(
    () => api.getHistory('transactions'),
    /exceeded the safe 20-page limit; no partial import was performed/,
  );
  assert.equal(calls, 20);
}

{
  let calls = 0;
  const api = new Trading212Api(
    mockContext((request) => {
      calls += 1;
      const url = new URL(request.url);
      if (calls === 2) {
        assert.equal(url.pathname, '/api/v0/equity/history/transactions');
        assert.equal(url.searchParams.get('cursor'), 'unused');
      }
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(
          calls === 1
            ? {
                items: [
                  { type: 'DEPOSIT', dateTime: '2026-07-31T13:00:00Z' },
                  { type: 'DEPOSIT', dateTime: '2026-07-31T00:30:00Z' },
                ],
                // Observed beta API compatibility case: Trading 212 has
                // returned a transaction cursor with the orders pathname.
                // The client validates the complete query, then rebuilds it
                // on the canonical read-only transactions endpoint.
                nextPagePath:
                  '/api/v0/equity/history/orders?cursor=unused&time=2026-07-30T23%3A00%3A00Z&limit=50',
              }
            : {
                items: [{ type: 'DEPOSIT', dateTime: '2026-07-30T23:00:00Z' }],
                nextPagePath: null,
              },
        ),
      };
    }),
  );
  const items = await api.getHistory('transactions');
  assert.equal(items.length, 3);
  assert.equal(calls, 2);
}

{
  let calls = 0;
  const api = new Trading212Api(
    mockContext(() => {
      calls += 1;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(
          calls === 1
            ? {
                items: [
                  { type: 'DEPOSIT', dateTime: '2026-07-31T00:30:00Z' },
                  { type: 'DEPOSIT', dateTime: '2026-07-31T13:00:00Z' },
                ],
                nextPagePath:
                  'limit=50&cursor=next&time=2026-07-30T23%3A00%3A00Z',
              }
            : {
                items: [{ type: 'DEPOSIT', dateTime: '2026-07-30T23:00:00Z' }],
                nextPagePath: null,
              },
        ),
      };
    }),
  );
  const items = await api.getHistory('transactions');
  assert.equal(items.length, 3);
  assert.equal(calls, 2);
}

{
  const requests: NetworkRequest[] = [];
  const api = new Trading212Api(
    mockContext((request) => {
      requests.push(request);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          items: [
            {
              fill: { filledAt: '2026-07-31T12:00:00Z' },
              order: {},
            },
          ],
          nextPagePath: null,
        }),
      };
    }),
  );
  const items = await api.getHistory('orders');
  assert.equal(items.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, 'GET');
  assert.equal(
    requests[0]?.url,
    'https://live.trading212.com/api/v0/equity/history/orders?limit=50',
  );
  assert.deepEqual(requests[0]?.auth, {
    type: 'basic',
    secretKey: 'trading212-basic-auth',
  });
}

{
  for (const stream of ['orders', 'dividends'] as const) {
    const requests: NetworkRequest[] = [];
    const api = new Trading212Api(
      mockContext((request) => {
        requests.push(request);
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            items: [],
            nextPagePath:
              requests.length === 1
                ? `/api/v0/equity/history/${stream}?limit=50&cursor=1782515373417`
                : null,
          }),
        };
      }),
    );
    await api.getHistory(stream);
    assert.equal(requests.length, 2);
    const secondUrl = new URL(requests[1]!.url);
    assert.equal(secondUrl.pathname, `/api/v0/equity/history/${stream}`);
    assert.equal(secondUrl.searchParams.get('cursor'), '1782515373417');
  }
}

{
  const rejectedStandardHistoryPaths = [
    '/api/v0/equity/history/orders?cursor=one',
    '/api/v0/equity/history/orders?cursor=1&cursor=2',
    '/api/v0/equity/history/orders?cursor=1&ticker=AAPL_US_EQ',
    '/api/v0/equity/history/orders?cursor=1&unknown=1',
    '/api/v0/equity/history/orders?cursor=1&limit=0',
    '/api/v0/equity/history/orders?cursor=1&limit=51',
    '/api/v0/equity/history/orders?cursor=1&limit=20&limit=50',
    '/api/v0/equity/history/dividends?cursor=1&ticker=AAPL_US_EQ',
  ];

  for (const nextPagePath of rejectedStandardHistoryPaths) {
    const stream = nextPagePath.includes('/dividends?') ? 'dividends' : 'orders';
    let calls = 0;
    const api = new Trading212Api(
      mockContext(() => {
        calls += 1;
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ items: [], nextPagePath }),
        };
      }),
    );
    await assert.rejects(
      () => api.getHistory(stream),
      /unsafe pagination path/,
    );
    assert.equal(calls, 1);
  }
}

{
  const api = new Trading212Api(
    mockContext(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ items: {}, nextPagePath: null }),
    })),
  );
  await assert.rejects(
    () => api.getHistory('orders'),
    /malformed orders history data/,
  );
}

{
  let calls = 0;
  const api = new Trading212Api(
    mockContext(() => {
      calls += 1;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          items: [],
          nextPagePath: 'https://evil.example/api/v0/equity/history/orders?cursor=1',
        }),
      };
    }),
  );
  await assert.rejects(
    () => api.getHistory('orders'),
    /unsafe pagination path/,
  );
  assert.equal(calls, 1);
}

{
  const api = new Trading212Api(
    mockContext(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ unexpected: true }),
    })),
  );
  await assert.rejects(() => api.getPositions(), /malformed positions data/);
}

{
  const api = new Trading212Api(
    mockContext(() => ({
      status: 429,
      headers: { 'x-ratelimit-reset': 'not-a-number' },
      body: '{}',
    })),
  );
  await assert.rejects(
    () => api.getAccountSummary(),
    (error: unknown) =>
      error instanceof Trading212ApiError && error.status === 429 && error.retryAt === undefined,
  );
}

{
  assert.equal(
    extractSafeValidationDetail(JSON.stringify({ message: 'Bad filtering arguments' })),
    'Bad filtering arguments',
  );
  assert.equal(
    extractSafeValidationDetail(JSON.stringify({ message: 'invalid cursor=opaque-secret-value' })),
    undefined,
  );
  const api = new Trading212Api(
    mockContext(() => ({
      status: 400,
      headers: {},
      body: JSON.stringify({ message: 'Bad filtering arguments' }),
    })),
  );
  await assert.rejects(
    () => api.getAccountSummary(),
    /HTTP 400: Bad filtering arguments/,
  );
}

console.log('api safety tests passed');

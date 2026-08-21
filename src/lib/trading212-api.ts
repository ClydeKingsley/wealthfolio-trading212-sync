import type { AddonContext } from '@wealthfolio/addon-sdk';
import {
  HISTORY_PAGE_DELAY_MS,
  MAX_HISTORY_PAGES,
  TRADING212_AUTH_SECRET,
  TRADING212_ORIGIN,
} from './constants';
import type {
  Trading212AccountSummary,
  Trading212Dividend,
  Trading212HistoricalOrder,
  Trading212Page,
  Trading212Position,
  Trading212Transaction,
} from '../types/trading212';
import { sleep } from './utils';

type StreamItemMap = {
  orders: Trading212HistoricalOrder;
  dividends: Trading212Dividend;
  transactions: Trading212Transaction;
};

const MIN_REQUEST_INTERVAL_MS: Record<string, number> = {
  'GET /api/v0/equity/account/summary': 5_100,
  'GET /api/v0/equity/positions': 1_100,
  'GET /api/v0/equity/history/orders': HISTORY_PAGE_DELAY_MS,
  'GET /api/v0/equity/history/dividends': HISTORY_PAGE_DELAY_MS,
  'GET /api/v0/equity/history/transactions': HISTORY_PAGE_DELAY_MS,
};
const lastRequestAt = new Map<string, number>();
const requestSlotQueues = new Map<string, Promise<void>>();
const NETWORK_TRANSPORT_ATTEMPTS = 2;

async function reserveRequestSlot(pathname: string, minimumInterval: number): Promise<void> {
  const previous = requestSlotQueues.get(pathname) ?? Promise.resolve();
  const reservation = previous.catch(() => undefined).then(async () => {
    const remaining = minimumInterval - (Date.now() - (lastRequestAt.get(pathname) ?? 0));
    if (remaining > 0) await sleep(remaining);
    lastRequestAt.set(pathname, Date.now());
  });
  requestSlotQueues.set(pathname, reservation);

  try {
    await reservation;
  } finally {
    if (requestSlotQueues.get(pathname) === reservation) {
      requestSlotQueues.delete(pathname);
    }
  }
}

export class Trading212ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryAt?: string,
  ) {
    super(message);
    this.name = 'Trading212ApiError';
  }
}

export class Trading212Api {
  constructor(
    private readonly ctx: AddonContext,
    private readonly authSecretKey = TRADING212_AUTH_SECRET,
  ) {}

  async getAccountSummary(): Promise<Trading212AccountSummary> {
    return this.getJson<Trading212AccountSummary>('/api/v0/equity/account/summary');
  }

  async getPositions(): Promise<Trading212Position[]> {
    const positions = await this.getJson<Trading212Position[]>('/api/v0/equity/positions');
    if (!Array.isArray(positions)) {
      throw new Trading212ApiError('Trading 212 returned malformed positions data.');
    }
    return positions;
  }

  async probeReadAccess(): Promise<void> {
    await Promise.all([
      this.getPositions(),
      this.getJson<Trading212Page<Trading212HistoricalOrder>>(
        '/api/v0/equity/history/orders?limit=1',
      ),
      this.getJson<Trading212Page<Trading212Dividend>>(
        '/api/v0/equity/history/dividends?limit=1',
      ),
      this.getJson<Trading212Page<Trading212Transaction>>(
        '/api/v0/equity/history/transactions?limit=1',
      ),
    ]);
  }

  async getHistory<TStream extends keyof StreamItemMap>(
    stream: TStream,
  ): Promise<StreamItemMap[TStream][]> {
    const items: StreamItemMap[TStream][] = [];
    let path = `/api/v0/equity/history/${stream}?limit=50`;
    const visitedPageKeys = new Set<string>();

    for (let pageNumber = 0; pageNumber < MAX_HISTORY_PAGES; pageNumber += 1) {
      const pageKey = this.historyPageKey(path, stream);
      if (visitedPageKeys.has(pageKey)) {
        throw new Trading212ApiError(`Trading 212 ${stream} pagination repeated a cursor.`);
      }
      visitedPageKeys.add(pageKey);
      const page = await this.getJson<Trading212Page<StreamItemMap[TStream]>>(path);
      if (!page || typeof page !== 'object' || !Array.isArray(page.items)) {
        throw new Trading212ApiError(`Trading 212 returned malformed ${stream} history data.`);
      }
      if (page.nextPagePath !== null && typeof page.nextPagePath !== 'string') {
        throw new Trading212ApiError(`Trading 212 returned malformed ${stream} pagination data.`);
      }
      if (page.nextPagePath === '') {
        throw new Trading212ApiError(`Trading 212 returned malformed ${stream} pagination data.`);
      }
      const pageItems = page.items;
      items.push(...pageItems);

      if (!page.nextPagePath) break;
      if (pageNumber === MAX_HISTORY_PAGES - 1) {
        throw new Trading212ApiError(
          `Trading 212 ${stream} history exceeded the safe ${MAX_HISTORY_PAGES}-page limit; no partial import was performed.`,
        );
      }
      path = this.validateHistoryPath(page.nextPagePath, stream);
    }

    return items;
  }

  private historyPageKey(path: string, stream: keyof StreamItemMap): string {
    const url = new URL(path, TRADING212_ORIGIN);
    const cursor = url.searchParams.get('cursor') ?? url.searchParams.get('cursorId');
    if (!cursor) return url.toString();
    const time = stream === 'transactions' ? (url.searchParams.get('time') ?? '') : '';
    // A cursor (plus the required transaction time) identifies a page even
    // if the server reorders parameters or changes their percent-encoding.
    return `${stream}\u0000${cursor}\u0000${time}`;
  }

  private validateHistoryPath(path: string, stream: keyof StreamItemMap): string {
    const expectedPath = `/api/v0/equity/history/${stream}`;
    const reject = (reason: string): never => {
      throw new Trading212ApiError(
        `Trading 212 returned an unsafe pagination path for ${stream} (${reason}; ${this.describePaginationPath(path)}).`,
      );
    };

    if (path !== path.trim() || /[\u0000-\u001f\u007f\\]/.test(path)) {
      return reject('invalid characters');
    }
    if (path.startsWith('//')) {
      return reject('scheme-relative URL');
    }

    const isBareTransactionQuery =
      stream === 'transactions' &&
      !path.startsWith('/') &&
      !path.startsWith('?') &&
      !path.includes('?') &&
      !/^[a-z][a-z\d+.-]*:/i.test(path) &&
      path.includes('=');
    const rawPathname = isBareTransactionQuery ? '' : (path.split(/[?#]/, 1)[0] ?? '');
    if (
      /%(?:2e|2f|5c)/i.test(rawPathname) ||
      /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPathname)
    ) {
      return reject('path traversal or encoded separator');
    }

    let candidate = path;
    if (isBareTransactionQuery) {
      // Trading 212's beta API has returned a query without the leading '?'
      // for transaction pagination. Treat it as query data only; validation
      // below still requires the complete official cursor/time parameter set.
      candidate = `${expectedPath}?${path}`;
    } else if (path.startsWith('?')) {
      candidate = `${expectedPath}${path}`;
    } else if (path.startsWith(`${stream}?`)) {
      candidate = `/api/v0/equity/history/${path}`;
    }

    let url: URL;
    try {
      url = new URL(candidate, TRADING212_ORIGIN);
    } catch {
      return reject('malformed URL');
    }

    if (
      url.origin !== TRADING212_ORIGIN ||
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return reject('unexpected origin');
    }
    if (url.hash) {
      return reject('fragment');
    }

    const normalizedPathname =
      url.pathname === `${expectedPath}/` ? expectedPath : url.pathname;
    const isKnownTransactionOrdersBug =
      stream === 'transactions' &&
      (normalizedPathname === '/api/v0/equity/history/orders' ||
        normalizedPathname === '/api/v0/equity/history/orders/');
    if (normalizedPathname !== expectedPath && !isKnownTransactionOrdersBug) {
      return reject('unexpected endpoint');
    }

    if (stream === 'transactions') {
      this.validateTransactionPaginationQuery(url, reject);
    } else {
      this.validateStandardHistoryPaginationQuery(url, reject);
    }

    // Always rebuild onto the canonical, allowlisted, read-only stream. This
    // is a narrowly-scoped compatibility workaround for two upstream beta API
    // variants: a bare query string and a transaction cursor mislabeled with
    // the orders pathname. The validated query is preserved byte-for-byte.
    return `${expectedPath}${url.search}`;
  }

  private validateTransactionPaginationQuery(
    url: URL,
    reject: (reason: string) => never,
  ): void {
    const allowedKeys = new Set(['cursor', 'time', 'limit']);
    const seenKeys = new Set<string>();

    for (const [key] of url.searchParams) {
      if (!allowedKeys.has(key)) {
        reject('unexpected transaction pagination parameter');
      }
      if (seenKeys.has(key)) {
        reject('duplicate transaction pagination parameter');
      }
      seenKeys.add(key);
    }

    const cursorValues = url.searchParams.getAll('cursor');
    const timeValues = url.searchParams.getAll('time');
    if (
      cursorValues.length !== 1 ||
      cursorValues[0] === '' ||
      cursorValues[0] !== cursorValues[0]!.trim() ||
      cursorValues[0]!.length > 2_048
    ) {
      reject('missing or invalid transaction cursor');
    }
    if (timeValues.length !== 1) {
      reject('missing transaction pagination time');
    }

    const time = timeValues[0]!;
    if (!this.isValidRfc3339(time)) {
      reject('invalid transaction pagination time');
    }

    const limitValues = url.searchParams.getAll('limit');
    if (limitValues.length > 1) {
      reject('duplicate transaction pagination limit');
    }
    if (limitValues.length === 1) {
      const limit = limitValues[0]!;
      const parsedLimit = Number(limit);
      if (!/^\d+$/.test(limit) || !Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
        reject('invalid transaction pagination limit');
      }
    }
  }

  private validateStandardHistoryPaginationQuery(
    url: URL,
    reject: (reason: string) => never,
  ): void {
    const allowedKeys = new Set(['cursor', 'limit']);
    const seenKeys = new Set<string>();

    for (const [key] of url.searchParams) {
      if (!allowedKeys.has(key)) {
        reject('unexpected history pagination parameter');
      }
      if (seenKeys.has(key)) {
        reject('duplicate history pagination parameter');
      }
      seenKeys.add(key);
    }

    const cursorValues = url.searchParams.getAll('cursor');
    if (cursorValues.length !== 1 || !/^\d{1,20}$/.test(cursorValues[0]!)) {
      reject('missing or invalid pagination cursor');
    }

    const limitValues = url.searchParams.getAll('limit');
    if (limitValues.length > 1) {
      reject('duplicate history pagination limit');
    }
    if (limitValues.length === 1) {
      const limit = limitValues[0]!;
      const parsedLimit = Number(limit);
      if (!/^\d+$/.test(limit) || !Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
        reject('invalid history pagination limit');
      }
    }
  }

  private isValidRfc3339(value: string): boolean {
    const match = value.match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/,
    );
    if (!match) return false;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const offsetHour = match[8] ? Number(match[9]) : 0;
    const offsetMinute = match[8] ? Number(match[10]) : 0;
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      offsetHour > 23 ||
      offsetMinute > 59
    ) {
      return false;
    }
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day <= daysInMonth && Number.isFinite(Date.parse(value));
  }

  private describePaginationPath(path: string): string {
    const form = path.startsWith('//')
      ? 'scheme-relative'
      : /^[a-z][a-z\d+.-]*:/i.test(path)
        ? 'absolute'
        : path.startsWith('/')
          ? 'root-relative'
          : path.startsWith('?')
            ? 'query-only'
            : 'bare';
    const knownSegments = new Set([
      'api',
      'v0',
      'equity',
      'history',
      'orders',
      'dividends',
      'transactions',
    ]);
    const knownKeys = new Set(['cursor', 'time', 'limit', 'ticker']);

    try {
      const candidate =
        form === 'bare' && path.includes('=') && !path.includes('?') ? `?${path}` : path;
      const url = new URL(candidate, TRADING212_ORIGIN);
      const maskedPath = url.pathname
        .split('/')
        .filter(Boolean)
        .map((segment) => {
          const normalized = segment.toLowerCase();
          return knownSegments.has(normalized) ? normalized : '[opaque]';
        })
        .join('/');
      const keys = Array.from(new Set(Array.from(url.searchParams.keys())))
        .map((key) => (knownKeys.has(key) ? key : '[unknown]'))
        .sort()
        .join(',');
      return `shape=${form}, path=/${maskedPath}, queryKeys=${keys || 'none'}`;
    } catch {
      return `shape=${form}, path=[unparseable], queryKeys=[unknown]`;
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    const url = new URL(path, TRADING212_ORIGIN);
    if (url.origin !== TRADING212_ORIGIN || !this.isAllowedReadPath(url.pathname)) {
      throw new Trading212ApiError('Blocked an unexpected Trading 212 API path.');
    }

    const response = await this.requestRaw(url);
    this.assertTrading212Success(response);

    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new Trading212ApiError('Trading 212 returned malformed JSON.');
    }
  }

  private async requestRaw(
    url: URL,
  ): Promise<Awaited<ReturnType<AddonContext['api']['network']['request']>>> {
    const requestKey = `GET ${url.pathname}`;
    const minimumInterval = MIN_REQUEST_INTERVAL_MS[requestKey];
    let response:
      | Awaited<ReturnType<AddonContext['api']['network']['request']>>
      | undefined;
    let lastTransportFailure: string | undefined;
    for (let attempt = 0; attempt < NETWORK_TRANSPORT_ATTEMPTS; attempt += 1) {
      if (minimumInterval) await reserveRequestSlot(requestKey, minimumInterval);
      try {
        response = await this.ctx.api.network.request({
          url: url.toString(),
          method: 'GET',
          headers: { Accept: 'application/json' },
          auth: { type: 'basic', secretKey: this.authSecretKey },
        });
        break;
      } catch (error) {
        const failure = classifySafeTransportFailure(error, url.pathname);
        lastTransportFailure = failure.message;
        if (!failure.retryable) {
          throw new Trading212ApiError(failure.message);
        }
        // Retrying is safe because every allowlisted request is GET.
      }
    }
    if (!response) {
      throw new Trading212ApiError(
        lastTransportFailure ??
          `Trading 212 ${url.pathname} failed before an HTTP response was received after one safe retry.`,
      );
    }
    return response;
  }

  private assertTrading212Success(
    response: Awaited<ReturnType<AddonContext['api']['network']['request']>>,
  ): void {
    if (response.status === 200) return;
    const reset = Object.entries(response.headers).find(
      ([name]) => name.toLowerCase() === 'x-ratelimit-reset',
    )?.[1];
    const resetSeconds = Number(reset);
    const retryAt =
      reset && Number.isFinite(resetSeconds)
        ? new Date(resetSeconds * 1000).toISOString()
        : undefined;
    const safeDetail = response.status === 400
      ? extractSafeValidationDetail(response.body)
      : undefined;
    const message =
      response.status === 401
        ? 'Trading 212 rejected the API key or secret.'
        : response.status === 403
          ? 'The Trading 212 API key is missing a required read-only scope.'
          : response.status === 429
            ? `Trading 212 rate limit reached${retryAt ? `; retry after ${retryAt}` : ''}.`
            : response.status === 400 && safeDetail
              ? `Trading 212 rejected the request with HTTP 400: ${safeDetail}`
              : `Trading 212 API request failed with HTTP ${response.status}.`;
    throw new Trading212ApiError(message, response.status, retryAt);
  }

  private isAllowedReadPath(pathname: string): boolean {
    return (
      pathname === '/api/v0/equity/account/summary' ||
      pathname === '/api/v0/equity/positions' ||
      pathname === '/api/v0/equity/history/orders' ||
      pathname === '/api/v0/equity/history/dividends' ||
      pathname === '/api/v0/equity/history/transactions'
    );
  }
}

function classifySafeTransportFailure(
  error: unknown,
  pathname: string,
): { message: string; retryable: boolean } {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (
    /size_limit_exceeded|response body (?:is )?too large|response size limit|response.*exceed(?:ed|s).*limit/i.test(
      raw,
    )
  ) {
    return {
      message: `Trading 212 ${pathname} was blocked because the response exceeded Wealthfolio's addon network size limit.`,
      retryable: false,
    };
  }
  return {
    message: `Trading 212 ${pathname} failed before an HTTP response was received after one safe retry.`,
    retryable: true,
  };
}

export function extractSafeValidationDetail(body: string): string | undefined {
  if (new TextEncoder().encode(body).byteLength > 8_192) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : undefined;
  const candidates = [
    record.message,
    record.detail,
    record.error_description,
    typeof record.error === 'string' ? record.error : undefined,
    nested?.message,
    nested?.detail,
  ];
  const unsafe = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]|(?:https?:\/\/|\/\/www\.|\bwww\.|\/api\/v\d+\/|\?[A-Za-z0-9_.~-]+=)|\b(?:authorization|basic|bearer|api[ _-]?key|api[ _-]?secret|password|secret|token|cursor(?:id)?)\b|[A-Za-z0-9_+/=-]{32,}/i;
  const safe = candidates
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 240 && !unsafe.test(value));
  return [...new Set(safe)].slice(0, 2).join('; ') || undefined;
}

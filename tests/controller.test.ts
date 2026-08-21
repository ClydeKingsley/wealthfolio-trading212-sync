import assert from 'node:assert/strict';
import type {
  Account,
  Activity,
  ActivityBulkMutationRequest,
  ActivityBulkMutationResult,
  ActivityCreate,
  ActivityDetails,
  ActivityImport,
  AddonContext,
  Asset,
  Holding,
  NetworkRequest,
  NetworkResponse,
  SymbolSearchResult,
} from '@wealthfolio/addon-sdk';
import { SyncController, validateDuplicateReference } from '../src/lib/sync-controller';
import {
  FULL_HISTORY_START_AT,
  STORAGE_KEYS,
  TRADING212_AUTH_SECRET,
  TRADING212_CANDIDATE_AUTH_SECRET,
} from '../src/lib/constants';
import { decimalString, stableHash } from '../src/lib/utils';
import type {
  Trading212AccountSummary,
  Trading212HistoricalOrder,
  MappedActivity,
  Trading212Position,
  Trading212Transaction,
} from '../src/types/trading212';

Object.assign(globalThis, {
  window: {
    setTimeout(callback: () => void) {
      callback();
      return 1;
    },
    clearTimeout() {},
    setInterval() {
      return 1;
    },
    clearInterval() {},
  },
});

const account = {
  id: 'wf-account-1',
  name: 'Trading 212 ISA',
  accountType: 'SECURITIES',
  balance: 0,
  currency: 'GBP',
  isDefault: false,
  isActive: true,
  isArchived: false,
  trackingMode: 'TRANSACTIONS',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
} satisfies Account;

const msftInstrument = {
  ticker: 'MSFT_US_EQ',
  isin: 'US5949181045',
  currency: 'USD',
  name: 'Microsoft Corporation',
};

const msftOrder = {
  fill: {
    filledAt: '2021-02-03T12:30:00Z',
    id: 9001,
    price: 100,
    quantity: 1,
    type: 'TRADE',
    walletImpact: {
      currency: 'GBP',
      fxRate: 0.75,
      netValue: 75,
      taxes: [],
    },
  },
  order: {
    id: 8001,
    side: 'BUY',
    ticker: msftInstrument.ticker,
    instrument: msftInstrument,
  },
} satisfies Trading212HistoricalOrder;

function marketResult(existingAssetId?: string): SymbolSearchResult {
  return {
    exchange: 'NASDAQ',
    exchangeMic: 'XNAS',
    canonicalSymbol: 'MSFT',
    canonicalExchangeMic: 'XNAS',
    providerId: 'YAHOO',
    providerSymbol: 'MSFT',
    currency: 'USD',
    shortName: 'Microsoft',
    longName: 'Microsoft Corporation',
    quoteType: 'EQUITY',
    symbol: 'MSFT',
    index: '',
    score: 1,
    typeDisplay: 'Equity',
    ...(existingAssetId
      ? { isExisting: true, existingAssetId }
      : { isExisting: false }),
  };
}

function assetProfile(
  id: string,
  symbol = 'MSFT',
  exchangeMic = 'XNAS',
  quoteCcy = 'USD',
): Asset {
  return {
    id,
    kind: 'INVESTMENT',
    name: symbol === 'MSFT' ? 'Microsoft Corporation' : symbol,
    displayCode: symbol,
    metadata: symbol === 'MSFT' ? { isin: msftInstrument.isin } : {},
    isActive: true,
    quoteMode: 'MARKET',
    quoteCcy,
    instrumentType: 'EQUITY',
    instrumentSymbol: symbol,
    instrumentExchangeMic: exchangeMic,
    instrumentKey: `EQUITY:${symbol}@${exchangeMic}`,
    providerConfig: { providerId: 'YAHOO', providerSymbol: symbol },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function cashHolding(quantity: number): Holding {
  return {
    id: 'cash-gbp',
    holdingType: 'cash',
    accountId: account.id,
    quantity,
    localCurrency: 'GBP',
  } as Holding;
}

function securityHolding(assetId: string, quantity: number): Holding {
  return {
    id: `holding-${assetId}`,
    holdingType: 'security',
    accountId: account.id,
    quantity,
    localCurrency: 'GBP',
    instrument: {
      id: assetId,
      symbol: 'MSFT',
      name: 'Microsoft Corporation',
      currency: 'USD',
      quoteMode: 'MARKET',
    },
  } as Holding;
}

function legacyV011PayloadDigest(activity: ActivityDetails): string {
  const canonicalNumber = (value: string | number | null | undefined) => {
    if (value === null || value === undefined || String(value).trim() === '') return undefined;
    return decimalString(Number(value)) ?? undefined;
  };
  return stableHash({
    accountId: activity.accountId,
    activityType: activity.activityType,
    subtype: activity.subtype ?? undefined,
    date: new Date(activity.date).toISOString(),
    currency: activity.currency.trim().toUpperCase(),
    amount:
      activity.activityType === 'BUY' || activity.activityType === 'SELL'
        ? undefined
        : canonicalNumber(activity.amount),
    quantity: canonicalNumber(activity.quantity),
    unitPrice: canonicalNumber(activity.unitPrice),
    fee: canonicalNumber(activity.fee),
    tax: canonicalNumber(activity.tax),
    fxRate: canonicalNumber(activity.fxRate),
    comment: activity.comment ?? undefined,
    sourceSystem: activity.sourceSystem,
    sourceRecordId: activity.sourceRecordId,
    idempotencyKey: activity.idempotencyKey,
    needsReview: Boolean(activity.needsReview),
  });
}

type SyncWireCreate = ActivityCreate & {
  sourceSystem: string;
  sourceRecordId: string;
  idempotencyKey: string;
  needsReview: boolean;
};

interface HarnessOptions {
  summary?: Trading212AccountSummary;
  positions?: Trading212Position[];
  orders?: Trading212HistoricalOrder[];
  transactions?: Trading212Transaction[];
  activities?: ActivityDetails[];
  holdings?: Holding[];
  assets?: Asset[];
  searchTicker?: (query: string) => Promise<SymbolSearchResult[]>;
  checkImport?: (rows: ActivityImport[]) => Promise<ActivityImport[]>;
  projectActivityDetailsAmount?: (create: ActivityCreate) => string | null;
  failSaveMany?: boolean;
  reactivateAssetsOnSave?: boolean;
}

interface Harness {
  ctx: AddonContext;
  storage: Map<string, string>;
  secrets: Map<string, string>;
  requests: NetworkRequest[];
  marketQueries: string[];
  saveCalls: ActivityBulkMutationRequest[];
  legacyImportCalls: number;
  activities: ActivityDetails[];
  assets: Map<string, Asset>;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const storage = new Map<string, string>();
  const secrets = new Map<string, string>();
  const requests: NetworkRequest[] = [];
  const marketQueries: string[] = [];
  const saveCalls: ActivityBulkMutationRequest[] = [];
  const activities = [...(options.activities ?? [])];
  const assets = new Map((options.assets ?? []).map((asset) => [asset.id, asset]));
  const createdAssetByIdentity = new Map<string, string>();
  let legacyImportCalls = 0;
  let activitySequence = 0;

  const respond = (request: NetworkRequest): NetworkResponse => {
    requests.push(request);
    const url = new URL(request.url);
    assert.equal(request.method, 'GET');
    if (url.pathname === '/api/v0/equity/account/summary') {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(
          options.summary ?? {
            id: 212001,
            currency: 'GBP',
            cash: { availableToTrade: 0, inPies: 0, reservedForOrders: 0 },
          },
        ),
      };
    }
    if (url.pathname === '/api/v0/equity/positions') {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(options.positions ?? []),
      };
    }
    if (url.pathname.startsWith('/api/v0/equity/history/')) {
      const items = url.pathname.endsWith('/orders')
        ? (options.orders ?? [])
        : url.pathname.endsWith('/transactions')
          ? (options.transactions ?? [])
          : [];
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ items, nextPagePath: null }),
      };
    }
    throw new Error(`Unexpected test URL: ${request.url}`);
  };

  const nativeSaveMany = async (
    request: ActivityBulkMutationRequest,
  ): Promise<ActivityBulkMutationResult> => {
    saveCalls.push(request);
    if (options.failSaveMany) {
      throw new Error('Injected native saveMany failure.');
    }
    const creates = request.creates ?? [];
    const created: Activity[] = [];
    const createdMappings: ActivityBulkMutationResult['createdMappings'] = [];

    for (const create of creates) {
      const wire = create as SyncWireCreate;
      let assetId = String(create.asset?.id ?? '').trim();
      if (!assetId && create.asset) {
        const identity = `${create.asset.symbol}|${create.asset.exchangeMic}`;
        assetId = createdAssetByIdentity.get(identity) ?? `asset-created-${create.asset.symbol}`;
        createdAssetByIdentity.set(identity, assetId);
        if (!assets.has(assetId)) {
          assets.set(
            assetId,
            assetProfile(
              assetId,
              String(create.asset.symbol),
              String(create.asset.exchangeMic),
              String(create.asset.quoteCcy),
            ),
          );
        }
      }
      if (assetId) {
        const profile = assets.get(assetId);
        if (!profile) throw new Error(`Test saveMany received unknown asset ${assetId}.`);
        if (options.reactivateAssetsOnSave !== false) profile.isActive = true;
      }

      activitySequence += 1;
      const id = `activity-created-${activitySequence}`;
      const timestamp = '2026-08-01T00:00:00Z';
      const activity: Activity = {
        id,
        accountId: create.accountId,
        ...(assetId ? { assetId } : {}),
        activityType: create.activityType,
        subtype: create.subtype ?? undefined,
        status: 'POSTED',
        isUserModified: false,
        activityDate: new Date(create.activityDate).toISOString(),
        quantity: create.quantity == null ? null : String(create.quantity),
        unitPrice: create.unitPrice == null ? null : String(create.unitPrice),
        amount: create.amount == null ? null : String(create.amount),
        fee: create.fee == null ? null : String(create.fee),
        tax: create.tax == null ? null : String(create.tax),
        currency: create.currency ?? '',
        fxRate: create.fxRate == null ? null : String(create.fxRate),
        notes: create.comment ?? undefined,
        sourceSystem: wire.sourceSystem,
        sourceRecordId: wire.sourceRecordId,
        idempotencyKey: wire.idempotencyKey,
        needsReview: wire.needsReview,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      created.push(activity);
      createdMappings.push({ tempId: create.id, activityId: id });
      const profile = assetId ? assets.get(assetId) : undefined;
      activities.push({
        id,
        accountId: create.accountId,
        accountName: account.name,
        accountCurrency: account.currency,
        activityType: create.activityType as ActivityDetails['activityType'],
        subtype: create.subtype ?? null,
        status: 'POSTED',
        isUserModified: false,
        date: new Date(create.activityDate),
        quantity: create.quantity == null ? null : String(create.quantity),
        unitPrice: create.unitPrice == null ? null : String(create.unitPrice),
        // Wealthfolio's ActivityDetails projection derives an absent amount
        // from quantity × unitPrice even though the persisted DB field and the
        // immediate Activity save result keep amount null.
        amount:
          options.projectActivityDetailsAmount
            ? options.projectActivityDetailsAmount(create)
            : create.amount == null
            ? create.quantity != null && create.unitPrice != null
              ? String(Number(create.quantity) * Number(create.unitPrice))
              : null
            : String(create.amount),
        fee: create.fee == null ? null : String(create.fee),
        tax: create.tax == null ? null : String(create.tax),
        currency: create.currency ?? '',
        needsReview: wire.needsReview,
        comment: create.comment ?? undefined,
        fxRate: create.fxRate == null ? null : String(create.fxRate),
        createdAt: new Date(timestamp),
        updatedAt: new Date(timestamp),
        assetId,
        assetSymbol: profile?.instrumentSymbol ?? '',
        assetName: profile?.name ?? undefined,
        exchangeMic: profile?.instrumentExchangeMic ?? undefined,
        sourceSystem: wire.sourceSystem,
        sourceRecordId: wire.sourceRecordId,
        idempotencyKey: wire.idempotencyKey,
      } as ActivityDetails);
    }

    return { created, createdMappings, updated: [], deleted: [], errors: [] };
  };

  const ctx = {
    api: {
      accounts: { getAll: async () => [account] },
      activities: {
        getAll: async () => [...activities],
        checkImport:
          options.checkImport ??
          (async (rows: ActivityImport[]) =>
            rows.map((row) => ({
              ...row,
              id: `checked-${row.lineNumber}`,
              isValid: true,
              isDraft: false,
              forceImport: false,
            }))),
        import: async () => {
          legacyImportCalls += 1;
          throw new Error('Legacy activities.import must not be used.');
        },
        saveMany: nativeSaveMany,
      },
      assets: {
        getProfile: async (assetId: string) => {
          const profile = assets.get(assetId);
          if (!profile) throw new Error(`Unknown test asset: ${assetId}`);
          return profile;
        },
      },
      market: {
        searchTicker: async (query: string) => {
          marketQueries.push(query);
          return options.searchTicker ? options.searchTicker(query) : [];
        },
      },
      portfolio: {
        getHoldings: async () => options.holdings ?? [cashHolding(0)],
      },
      network: { request: async (request: NetworkRequest) => respond(request) },
      storage: {
        get: async (key: string) => storage.get(key) ?? null,
        set: async (key: string, value: string) => {
          storage.set(key, value);
        },
        delete: async (key: string) => {
          storage.delete(key);
        },
      },
      secrets: {
        set: async (key: string, value: string) => {
          secrets.set(key, value);
        },
        delete: async (key: string) => {
          secrets.delete(key);
        },
      },
      toast: { success() {}, warning() {}, error() {}, info() {} },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    },
  } as unknown as AddonContext;

  return {
    ctx,
    storage,
    secrets,
    requests,
    marketQueries,
    saveCalls,
    get legacyImportCalls() {
      return legacyImportCalls;
    },
    activities,
    assets,
  };
}

async function connect(controller: SyncController) {
  await controller.initialize();
  const proposal = await controller.getBaselineProposal(account.id);
  assert.equal(proposal.localActivityCount, 0);
  assert.equal(proposal.baselineAt, FULL_HISTORY_START_AT);
  return controller.configure(account.id, 'api-key', 'api-secret', proposal.baselineAt, true);
}

// An empty account performs a real from-zero history import. Cash rows never
// invoke market search and are written through the same native saveMany batch.
{
  const harness = makeHarness({
    summary: {
      id: 212001,
      currency: 'GBP',
      cash: { availableToTrade: 100, inPies: 0, reservedForOrders: 0 },
    },
    transactions: [
      {
        amount: 100,
        currency: 'GBP',
        dateTime: '2021-01-04T09:15:00Z',
        reference: 'first-deposit',
        type: 'DEPOSIT',
      },
    ],
    holdings: [cashHolding(100)],
  });
  const controller = new SyncController(harness.ctx);
  const summary = await connect(controller);

  assert.equal(summary.historyStartAt, FULL_HISTORY_START_AT);
  assert.equal(summary.streamCoverage?.transactions.earliestAt, '2021-01-04T09:15:00.000Z');
  assert.equal(summary.imported, 1);
  assert.equal(summary.reconciliation?.complete, true);
  assert.equal(controller.getState().autoEnabled, true);
  assert.equal(harness.saveCalls.length, 1);
  assert.equal(harness.saveCalls[0]?.creates?.[0]?.activityType, 'DEPOSIT');
  assert.equal(harness.saveCalls[0]?.creates?.[0]?.asset, undefined);
  assert.deepEqual(harness.marketQueries, []);
  assert.equal(harness.legacyImportCalls, 0);

  const fullHistoryRequests = harness.requests.filter((request) => {
    const url = new URL(request.url);
    return url.pathname.startsWith('/api/v0/equity/history/') && url.searchParams.get('limit') === '50';
  });
  assert.equal(fullHistoryRequests.length, 3);
  for (const request of fullHistoryRequests) {
    const url = new URL(request.url);
    assert.equal(url.searchParams.has('time'), false);
    assert.equal(url.searchParams.has('cursor'), false);
  }
}

// A previously unseen stock is resolved from the instrument embedded in the
// account's Trading 212 records and created without a user-supplied UUID.
{
  const createdAssetId = 'asset-created-MSFT';
  const harness = makeHarness({
    summary: {
      id: 212001,
      currency: 'GBP',
      cash: { availableToTrade: 40, inPies: 0, reservedForOrders: 0 },
    },
    orders: [msftOrder],
    positions: [{ quantity: 1, instrument: msftInstrument }],
    holdings: [cashHolding(40), securityHolding(createdAssetId, 1)],
    searchTicker: async (query) => (query === 'MSFT' ? [marketResult()] : []),
  });
  const controller = new SyncController(harness.ctx);
  const summary = await connect(controller);

  assert.equal(summary.imported, 1);
  assert.equal(summary.pendingTotal, 0);
  assert.equal(summary.reconciliation?.complete, true);
  assert.deepEqual(harness.marketQueries, ['MSFT']);
  assert.equal(harness.saveCalls.length, 1);
  const create = harness.saveCalls[0]?.creates?.[0];
  assert.ok(create?.asset);
  assert.equal(create.asset.id, undefined);
  assert.deepEqual(
    {
      symbol: create.asset.symbol,
      exchangeMic: create.asset.exchangeMic,
      quoteCcy: create.asset.quoteCcy,
      instrumentType: create.asset.instrumentType,
      providerId: create.asset.providerId,
      providerSymbol: create.asset.providerSymbol,
    },
    {
      symbol: 'MSFT',
      exchangeMic: 'XNAS',
      quoteCcy: 'USD',
      instrumentType: 'EQUITY',
      providerId: 'YAHOO',
      providerSymbol: 'MSFT',
    },
  );
  assert.equal(harness.assets.has(createdAssetId), true);
  assert.equal(harness.storage.has(STORAGE_KEYS.legacyAssetBindings), false);
  assert.equal(harness.legacyImportCalls, 0);
  assert.equal(
    harness.requests.some(
      (request) => new URL(request.url).pathname === '/api/v0/equity/metadata/instruments',
    ),
    false,
  );
}

// A historical ticker alias is normalized to the unique current-position
// instrument with the same ISIN and currency before native asset resolution.
{
  const currentInstrument = {
    ticker: 'FFAI_US_EQ',
    isin: 'US3073598696',
    currency: 'USD',
    name: 'Faraday Future Intelligent Electric Inc.',
  };
  const historicalInstrument = {
    ticker: 'PSAC_US_EQ',
    isin: currentInstrument.isin,
    currency: currentInstrument.currency,
    name: 'Property Solutions Acquisition Corp.',
  };
  const ffaiResult: SymbolSearchResult = {
    ...marketResult(),
    canonicalSymbol: 'FFAI',
    providerSymbol: 'FFAI',
    shortName: 'Faraday Future',
    longName: currentInstrument.name,
    symbol: 'FFAI',
  };
  const harness = makeHarness({
    summary: {
      id: 212001,
      currency: 'GBP',
      cash: { availableToTrade: 40, inPies: 0, reservedForOrders: 0 },
    },
    orders: [
      {
        fill: {
          filledAt: '2021-02-03T12:30:00Z',
          id: 9002,
          price: 100,
          quantity: 1,
          type: 'TRADE',
          walletImpact: {
            currency: 'GBP',
            fxRate: 0.75,
            netValue: 75,
            taxes: [],
          },
        },
        order: {
          id: 8002,
          side: 'BUY',
          ticker: historicalInstrument.ticker,
          instrument: historicalInstrument,
        },
      },
    ],
    positions: [{ quantity: 1, instrument: currentInstrument }],
    holdings: [cashHolding(40), securityHolding('asset-created-FFAI', 1)],
    searchTicker: async (query) => (query === 'FFAI' ? [ffaiResult] : []),
  });
  const controller = new SyncController(harness.ctx);
  const summary = await connect(controller);

  assert.equal(summary.imported, 1);
  assert.equal(summary.pendingTotal, 0);
  assert.equal(summary.reconciliation?.complete, true);
  assert.deepEqual(harness.marketQueries, ['FFAI']);
  assert.equal(harness.saveCalls[0]?.creates?.[0]?.asset?.symbol, 'FFAI');
}

// A completely empty securities catalogue also supports a stock first bought
// after the initial sync. The five-minute path must run the same native market
// resolution and create the new security without a UUID or manual mapping.
{
  const appleInstrument = {
    ticker: 'AAPL_US_EQ',
    isin: 'US0378331005',
    currency: 'USD',
    name: 'Apple Inc.',
  };
  const appleOrder = {
    fill: {
      filledAt: '2026-08-01T11:00:00Z',
      id: 9101,
      price: 30,
      quantity: 2,
      type: 'TRADE',
      walletImpact: {
        currency: 'GBP',
        fxRate: 0.75,
        netValue: 45,
        taxes: [],
      },
    },
    order: {
      id: 8101,
      side: 'BUY',
      ticker: appleInstrument.ticker,
      instrument: appleInstrument,
    },
  } satisfies Trading212HistoricalOrder;
  const appleResult = {
    ...marketResult(),
    canonicalSymbol: 'AAPL',
    symbol: 'AAPL',
    providerSymbol: 'AAPL',
    shortName: 'Apple',
    longName: appleInstrument.name,
  } satisfies SymbolSearchResult;
  const orders: Trading212HistoricalOrder[] = [msftOrder];
  const positions: Trading212Position[] = [
    { quantity: 1, instrument: msftInstrument },
  ];
  const holdings: Holding[] = [
    cashHolding(40),
    securityHolding('asset-created-MSFT', 1),
  ];
  const harness = makeHarness({
    summary: {
      id: 212001,
      currency: 'GBP',
      cash: { availableToTrade: 40, inPies: 0, reservedForOrders: 0 },
    },
    orders,
    positions,
    holdings,
    assets: [],
    searchTicker: async (query) =>
      query === 'MSFT' ? [marketResult()] : query === 'AAPL' ? [appleResult] : [],
  });
  assert.equal(harness.assets.size, 0);
  const controller = new SyncController(harness.ctx);
  const first = await connect(controller);
  assert.equal(first.imported, 1);
  assert.equal(first.reconciliation?.complete, true);
  assert.equal(harness.assets.size, 1);

  orders.push(appleOrder);
  positions.push({ quantity: 2, instrument: appleInstrument });
  holdings.push(securityHolding('asset-created-AAPL', 2));
  const second = await controller.syncNow();
  assert.equal(second.imported, 1);
  assert.equal(second.alreadySeen, 1);
  assert.equal(second.autoPaused, false);
  assert.equal(second.reconciliation?.complete, true);
  assert.equal(harness.saveCalls.length, 2);
  assert.equal(harness.saveCalls[1]?.creates?.[0]?.asset?.symbol, 'AAPL');
  assert.equal(harness.assets.has('asset-created-AAPL'), true);
  assert.equal(harness.marketQueries.includes('AAPL'), true);
}

// Native validation may enrich the exact identity but cannot silently replace
// it. A changed symbol/MIC/provider is blocked before saveMany.
{
  const harness = makeHarness({
    summary: {
      id: 212001,
      currency: 'GBP',
      cash: { availableToTrade: 40, inPies: 0, reservedForOrders: 0 },
    },
    orders: [msftOrder],
    positions: [{ quantity: 1, instrument: msftInstrument }],
    holdings: [cashHolding(40)],
    searchTicker: async (query) => (query === 'MSFT' ? [marketResult()] : []),
    checkImport: async (rows) =>
      rows.map((row) => ({
        ...row,
        id: `checked-${row.lineNumber}`,
        symbol: 'OTHER',
        exchangeMic: 'XNYS',
        providerSymbol: 'OTHER',
        isValid: true,
        isDraft: false,
        forceImport: false,
      })),
  });
  const controller = new SyncController(harness.ctx);
  const blocked = await connect(controller);
  assert.equal(blocked.imported, 0);
  assert.equal(blocked.autoPaused, true);
  assert.match(blocked.autoPauseReason ?? '', /symbol.*exchangeMic.*providerSymbol/i);
  assert.equal(harness.saveCalls.length, 0);
  assert.equal(harness.assets.size, 0);
}

// An exact native market hit reuses Wealthfolio's existing asset automatically;
// it still needs no manual confirmation or UUID entry.
{
  const existingAssetId = 'asset-existing-msft';
  const existingAsset = assetProfile(existingAssetId);
  const harness = makeHarness({
    summary: {
      id: 212001,
      currency: 'GBP',
      cash: { availableToTrade: 20, inPies: 0, reservedForOrders: 0 },
    },
    orders: [msftOrder],
    positions: [{ quantity: 1, instrument: msftInstrument }],
    holdings: [cashHolding(20), securityHolding(existingAssetId, 1)],
    assets: [existingAsset],
    searchTicker: async () => [marketResult(existingAssetId)],
  });
  const controller = new SyncController(harness.ctx);
  const summary = await connect(controller);

  assert.equal(summary.reconciliation?.complete, true);
  assert.equal(harness.saveCalls[0]?.creates?.[0]?.asset?.id, existingAssetId);
  assert.equal(harness.assets.size, 1);
  assert.equal(harness.storage.has(STORAGE_KEYS.legacyAssetBindings), false);
  assert.equal(controller.getState().autoEnabled, true);
}

// If Wealthfolio ever reports a successful save but fails to reactivate an
// exact inactive asset, post-write verification must stop the run and retain
// recovery evidence instead of marking the source record as seen.
{
  const existingAssetId = 'asset-inactive-msft';
  const inactiveAsset = assetProfile(existingAssetId);
  inactiveAsset.isActive = false;
  const harness = makeHarness({
    summary: {
      id: 212001,
      currency: 'GBP',
      cash: { availableToTrade: 20, inPies: 0, reservedForOrders: 0 },
    },
    orders: [msftOrder],
    positions: [{ quantity: 1, instrument: msftInstrument }],
    holdings: [cashHolding(20), securityHolding(existingAssetId, 1)],
    assets: [inactiveAsset],
    searchTicker: async () => [marketResult(existingAssetId)],
    reactivateAssetsOnSave: false,
  });
  const controller = new SyncController(harness.ctx);
  await assert.rejects(() => connect(controller), /inactive or mismatched native asset profile/i);
  assert.equal(harness.saveCalls.length, 1);
  assert.equal(harness.activities.length, 1);
  assert.equal(harness.storage.has(STORAGE_KEYS.importInProgress), true);
  assert.equal(harness.storage.get(STORAGE_KEYS.reconciliationBlocked), 'true');
  assert.equal(
    [...harness.storage.keys()].some((key) => key.startsWith(STORAGE_KEYS.seenShardPrefix)),
    false,
  );
  assert.equal(controller.getState().autoEnabled, false);
}

// A native write failure leaves the verified crash-recovery marker in place and
// pauses automation rather than retrying an uncertain write blindly.
{
  const harness = makeHarness({
    summary: {
      id: 212001,
      currency: 'GBP',
      cash: { availableToTrade: 10, inPies: 0, reservedForOrders: 0 },
    },
    transactions: [
      {
        amount: 10,
        currency: 'GBP',
        dateTime: '2022-04-05T11:00:00Z',
        reference: 'deposit-before-failure',
        type: 'DEPOSIT',
      },
    ],
    holdings: [cashHolding(10)],
    failSaveMany: true,
  });
  const controller = new SyncController(harness.ctx);
  await assert.rejects(() => connect(controller), /Injected native saveMany failure/);

  const marker = JSON.parse(harness.storage.get(STORAGE_KEYS.importInProgress) ?? '{}');
  assert.equal(marker.schemaVersion, 3);
  assert.equal(marker.phase, 'write-attempted');
  assert.equal(marker.candidateCount, 1);
  assert.equal(harness.storage.get(STORAGE_KEYS.autoEnabled), 'false');
  assert.equal(harness.storage.get(STORAGE_KEYS.reconciliationBlocked), 'true');
  assert.equal(controller.getState().autoEnabled, false);
  assert.equal(harness.saveCalls.length, 1);
}

// Successful persistence is not enough: a holdings/cash mismatch pauses the
// five-minute loop and keeps the recovery marker until reconciliation succeeds.
{
  const harness = makeHarness({
    summary: {
      id: 212001,
      currency: 'GBP',
      cash: { availableToTrade: 100, inPies: 0, reservedForOrders: 0 },
    },
    transactions: [
      {
        amount: 100,
        currency: 'GBP',
        dateTime: '2023-06-07T10:00:00Z',
        reference: 'mismatched-deposit',
        type: 'DEPOSIT',
      },
    ],
    holdings: [cashHolding(90)],
  });
  const controller = new SyncController(harness.ctx);
  const summary = await connect(controller);

  assert.equal(summary.imported, 1);
  assert.equal(summary.reconciliation?.complete, false);
  assert.equal(summary.autoPaused, true);
  assert.match(summary.autoPauseReason ?? '', /holdings or cash do not match/i);
  assert.equal(harness.storage.get(STORAGE_KEYS.autoEnabled), 'false');
  assert.equal(harness.storage.get(STORAGE_KEYS.reconciliationBlocked), 'true');
  assert.equal(harness.storage.has(STORAGE_KEYS.importInProgress), true);
  assert.equal(controller.getState().autoEnabled, false);
}

// A committed 0.1.11 / early-0.1.12 trade batch is recovered after restart
// even though that ledger omitted Wealthfolio's derived ActivityDetails amount.
{
  const harness = makeHarness({
    summary: {
      id: 212001,
      currency: 'GBP',
      cash: { availableToTrade: 0, inPies: 0, reservedForOrders: 0 },
    },
    orders: [msftOrder],
    positions: [{ quantity: 1, instrument: msftInstrument }],
    holdings: [cashHolding(0)],
    searchTicker: async (query) => (query === 'MSFT' ? [marketResult()] : []),
  });
  const firstController = new SyncController(harness.ctx);
  const firstSummary = await connect(firstController);
  assert.equal(firstSummary.imported, 1);
  assert.equal(firstSummary.reconciliation?.complete, false);

  const marker = JSON.parse(harness.storage.get(STORAGE_KEYS.importInProgress) ?? '{}');
  assert.equal(marker.phase, 'committed');
  assert.equal(marker.candidateCount, 1);
  marker.candidates[0].payloadDigest = legacyV011PayloadDigest(harness.activities[0]!);
  marker.batchFingerprint = stableHash(
    [...marker.candidates].sort((left, right) => left.remoteKey.localeCompare(right.remoteKey)),
  );
  harness.storage.set(STORAGE_KEYS.importInProgress, JSON.stringify(marker));
  firstController.dispose();

  const restartedController = new SyncController(harness.ctx);
  await restartedController.initialize();
  const recoveredSummary = await restartedController.syncNow();
  assert.equal(recoveredSummary.imported, 0);
  assert.equal(harness.storage.has(STORAGE_KEYS.importInProgress), false);
  assert.equal(harness.saveCalls.length, 1);
}

// Seen-state must not treat Wealthfolio's newly assigned asset UUID as a
// Trading 212 payload change. A previously persisted history row may also be
// retained safely when the API later omits identity enrichment, but the same
// omission on a new fill remains blocking.
{
  const secondOrder = {
    fill: {
      ...msftOrder.fill,
      id: 9002,
      filledAt: '2021-02-04T12:30:00Z',
    },
    order: {
      ...msftOrder.order,
      id: 8002,
    },
  } satisfies Trading212HistoricalOrder;
  const orders: Trading212HistoricalOrder[] = [msftOrder, secondOrder];
  let marketLookupCount = 0;
  const harness = makeHarness({
    summary: {
      id: 212001,
      currency: 'GBP',
      cash: { availableToTrade: 0, inPies: 0, reservedForOrders: 0 },
    },
    orders,
    positions: [{ quantity: 2, instrument: msftInstrument }],
    holdings: [cashHolding(0), securityHolding('asset-created-MSFT', 2)],
    searchTicker: async (query) => {
      if (query !== 'MSFT') return [];
      marketLookupCount += 1;
      return [marketResult(marketLookupCount === 1 ? undefined : 'asset-created-MSFT')];
    },
  });
  const controller = new SyncController(harness.ctx);
  const firstSummary = await connect(controller);
  assert.equal(firstSummary.imported, 2);
  assert.equal(firstSummary.reconciliation?.complete, true);
  assert.equal(harness.saveCalls.length, 1);

  orders[0] = { fill: msftOrder.fill };
  const retainedSummary = await controller.syncNow();
  assert.equal(retainedSummary.imported, 0);
  assert.equal(retainedSummary.alreadySeen, 1);
  assert.equal(retainedSummary.reconciliation?.complete, true);
  assert.equal(retainedSummary.autoPaused, false);
  assert.equal(retainedSummary.pendingTotal, 1);
  assert.equal(retainedSummary.pending[0]?.blocksAutomaticImport, undefined);
  assert.match(retainedSummary.pending[0]?.reason ?? '', /Previously imported Trading 212 history/);
  assert.equal(harness.saveCalls.length, 1);

  orders.push({
    fill: {
      ...msftOrder.fill,
      id: 9003,
      filledAt: '2021-02-05T12:30:00Z',
    },
  });
  const blockedSummary = await controller.syncNow();
  assert.equal(blockedSummary.imported, 0);
  assert.equal(blockedSummary.autoPaused, true);
  assert.equal(blockedSummary.pending[0]?.blocksAutomaticImport, true);
  assert.match(blockedSummary.autoPauseReason ?? '', /Order fields are incomplete/);
  assert.equal(harness.saveCalls.length, 1);
}

// Wealthfolio derives trade amount with exact Rust Decimal arithmetic. The
// cross-projection checks must normalize both sides from quantity and price,
// not compare that value with JavaScript's binary floating-point spelling.
{
  const quantity = 133.28365797;
  const unitPrice = 50.88;
  const exactProjectedAmount = '6781.4725175136';
  const precisionOrder = {
    fill: {
      filledAt: '2026-07-30T12:30:00Z',
      id: 9901,
      price: unitPrice,
      quantity,
      type: 'TRADE',
      walletImpact: {
        currency: 'GBP',
        fxRate: 1,
        netValue: Number(exactProjectedAmount),
        taxes: [],
      },
    },
    order: {
      id: 9801,
      side: 'BUY',
      ticker: msftInstrument.ticker,
      instrument: msftInstrument,
    },
  } satisfies Trading212HistoricalOrder;
  const harness = makeHarness({
    summary: {
      id: 212001,
      currency: 'GBP',
      cash: { availableToTrade: 0, inPies: 0, reservedForOrders: 0 },
    },
    orders: [precisionOrder],
    positions: [{ quantity, instrument: msftInstrument }],
    holdings: [cashHolding(0)],
    searchTicker: async (query) => (query === 'MSFT' ? [marketResult()] : []),
    projectActivityDetailsAmount: (create) =>
      create.activityType === 'BUY' || create.activityType === 'SELL'
        ? exactProjectedAmount
        : create.amount == null
          ? null
          : String(create.amount),
  });
  const firstController = new SyncController(harness.ctx);
  const firstSummary = await connect(firstController);
  assert.equal(firstSummary.imported, 1);
  assert.equal(firstSummary.reconciliation?.complete, false);
  assert.equal(harness.storage.has(STORAGE_KEYS.importInProgress), true);
  firstController.dispose();

  const restartedController = new SyncController(harness.ctx);
  await restartedController.initialize();
  const recoveredSummary = await restartedController.syncNow();
  assert.equal(recoveredSummary.imported, 0);
  assert.equal(harness.storage.has(STORAGE_KEYS.importInProgress), false);
  assert.equal(harness.saveCalls.length, 1);

  const persisted = harness.activities[0]!;
  const duplicateCandidate = {
    stream: 'orders',
    remoteKey: persisted.sourceRecordId!,
    remoteDate: new Date(persisted.date).toISOString(),
    signature: 'precision-signature',
    activity: {
      accountId: account.id,
      activityType: 'BUY',
      date: new Date(persisted.date).toISOString(),
      symbol: 'MSFT',
      quantity: String(quantity),
      unitPrice: String(unitPrice),
      amount: null,
      fee: null,
      tax: null,
      currency: 'USD',
      fxRate: '1',
      isin: msftInstrument.isin,
      isValid: true,
      isDraft: false,
      forceImport: false,
    },
    instrumentIdentity: '[precision]',
    remoteInstrument: msftInstrument,
  } as MappedActivity;
  assert.equal(
    validateDuplicateReference(
      duplicateCandidate,
      persisted,
      account.id,
      persisted.assetId,
    ),
    undefined,
  );
  assert.match(
    validateDuplicateReference(
      duplicateCandidate,
      { ...persisted, unitPrice: '50.89' },
      account.id,
      persisted.assetId,
    ) ?? '',
    /immutable economic fields/,
  );
  assert.match(
    validateDuplicateReference(
      duplicateCandidate,
      { ...persisted, status: 'VOID' },
      account.id,
      persisted.assetId,
    ) ?? '',
    /edited or is not posted/,
  );
}

// Wealthfolio 3.6.2 can return one exact inactive existing asset for an ISIN
// query even though its native asset profile does not persist that ISIN. A
// deleted account can leave this lifecycle state behind; native saveMany must
// reactivate the same UUID when symbol/MIC/currency/profile all agree. A
// present, conflicting profile ISIN must still block before any write.
{
  const renamedInstrument = {
    ticker: 'PSAC_US_EQ',
    isin: 'US3073598696',
    currency: 'USD',
    name: 'Property Solutions Acquisition Corp.',
  };
  const renamedOrder = {
    fill: {
      filledAt: '2026-02-05T14:42:54Z',
      id: 771001,
      price: 10,
      quantity: 1,
      type: 'TRADE',
      walletImpact: { currency: 'GBP', fxRate: 1, netValue: 10, taxes: [] },
    },
    order: {
      id: 770001,
      side: 'BUY',
      ticker: renamedInstrument.ticker,
      instrument: renamedInstrument,
    },
  } satisfies Trading212HistoricalOrder;
  const renamedResult = {
    ...marketResult('asset-renamed'),
    canonicalSymbol: 'FFAI',
    symbol: 'FFAI',
    providerSymbol: 'FFAI',
    shortName: 'Faraday Future',
    longName: 'Faraday Future Intelligent Electric Inc.',
  } satisfies SymbolSearchResult;
  const searchRenamed = async (query: string) =>
    query === renamedInstrument.isin ? [renamedResult] : [];
  const makeRenamedHarness = (
    assets: Asset[],
    searchTicker: (query: string) => Promise<SymbolSearchResult[]> = searchRenamed,
  ) =>
    makeHarness({
      summary: {
        id: 212001,
        currency: 'GBP',
        cash: { availableToTrade: 0, inPies: 0, reservedForOrders: 0 },
      },
      orders: [renamedOrder],
      holdings: [cashHolding(0)],
      assets,
      searchTicker,
    });

  const inactiveMissingIsinProfile = assetProfile(
    'asset-renamed',
    'FFAI',
    'XNAS',
    'USD',
  );
  inactiveMissingIsinProfile.isActive = false;
  const missingIsinHarness = makeRenamedHarness([inactiveMissingIsinProfile]);
  const missingIsinController = new SyncController(missingIsinHarness.ctx);
  const imported = await connect(missingIsinController);
  assert.equal(imported.imported, 1);
  assert.equal(imported.autoPaused, false);
  assert.equal(imported.reconciliation?.complete, true);
  assert.deepEqual(missingIsinHarness.marketQueries, ['PSAC', renamedInstrument.isin]);
  assert.equal(
    missingIsinHarness.saveCalls[0]?.creates?.[0]?.asset?.id,
    'asset-renamed',
  );
  assert.equal(missingIsinHarness.assets.size, 1);
  assert.equal(missingIsinHarness.assets.get('asset-renamed')?.isActive, true);

  const matchingProfile = assetProfile('asset-renamed', 'FFAI', 'XNAS', 'USD');
  matchingProfile.metadata = { isin: renamedInstrument.isin };
  const matchingIsinHarness = makeRenamedHarness([matchingProfile]);
  const matchingIsinController = new SyncController(matchingIsinHarness.ctx);
  const matching = await connect(matchingIsinController);
  assert.equal(matching.imported, 1);
  assert.equal(matching.autoPaused, false);
  assert.equal(
    matchingIsinHarness.saveCalls[0]?.creates?.[0]?.asset?.id,
    'asset-renamed',
  );

  const conflictingProfile = assetProfile('asset-renamed', 'FFAI', 'XNAS', 'USD');
  conflictingProfile.isActive = false;
  conflictingProfile.metadata = { isin: msftInstrument.isin };
  const conflictingIsinHarness = makeRenamedHarness([conflictingProfile]);
  const conflictingIsinController = new SyncController(conflictingIsinHarness.ctx);
  const blocked = await connect(conflictingIsinController);
  assert.equal(blocked.imported, 0);
  assert.equal(blocked.autoPaused, true);
  assert.match(blocked.autoPauseReason ?? '', /carries a conflicting ISIN/);
  assert.equal(conflictingIsinHarness.saveCalls.length, 0);

  const invalidIsinProfile = assetProfile('asset-renamed', 'FFAI', 'XNAS', 'USD');
  invalidIsinProfile.metadata = { isin: 'not-an-isin' };
  const multipleIsinProfile = assetProfile('asset-renamed', 'FFAI', 'XNAS', 'USD');
  multipleIsinProfile.metadata = { isin: renamedInstrument.isin };
  multipleIsinProfile.providerConfig = {
    ...multipleIsinProfile.providerConfig,
    isin: msftInstrument.isin,
  };
  for (const profile of [invalidIsinProfile, multipleIsinProfile]) {
    const harness = makeRenamedHarness([profile]);
    const controller = new SyncController(harness.ctx);
    const unsafeIsin = await connect(controller);
    assert.equal(unsafeIsin.imported, 0);
    assert.equal(unsafeIsin.autoPaused, true);
    assert.match(unsafeIsin.autoPauseReason ?? '', /carries a conflicting ISIN/);
    assert.equal(harness.saveCalls.length, 0);
  }

  const wrongTypeProfile = assetProfile('asset-renamed', 'FFAI', 'XNAS', 'USD');
  wrongTypeProfile.instrumentType = 'BOND';
  const incompatibleProfiles = [
    assetProfile('asset-renamed', 'PSAC', 'XNAS', 'USD'),
    assetProfile('asset-renamed', 'FFAI', 'XNYS', 'USD'),
    assetProfile('asset-renamed', 'FFAI', 'XNAS', 'EUR'),
    wrongTypeProfile,
  ];
  for (const profile of incompatibleProfiles) {
    const harness = makeRenamedHarness([profile]);
    const controller = new SyncController(harness.ctx);
    const incompatible = await connect(controller);
    assert.equal(incompatible.imported, 0);
    assert.equal(incompatible.autoPaused, true);
    assert.match(incompatible.autoPauseReason ?? '', /conflicts with its current/);
    assert.equal(harness.saveCalls.length, 0);
  }

  const mismatchedIdHarness = makeRenamedHarness([]);
  mismatchedIdHarness.assets.set(
    'asset-renamed',
    assetProfile('different-profile-id', 'FFAI', 'XNAS', 'USD'),
  );
  const mismatchedIdController = new SyncController(mismatchedIdHarness.ctx);
  const mismatchedId = await connect(mismatchedIdController);
  assert.equal(mismatchedId.imported, 0);
  assert.equal(mismatchedId.autoPaused, true);
  assert.equal(mismatchedIdHarness.saveCalls.length, 0);

  const secondExistingResult = {
    ...renamedResult,
    existingAssetId: 'asset-renamed-2',
  } satisfies SymbolSearchResult;
  const ambiguousExistingHarness = makeRenamedHarness(
    [
      assetProfile('asset-renamed', 'FFAI', 'XNAS', 'USD'),
      assetProfile('asset-renamed-2', 'FFAI', 'XNAS', 'USD'),
    ],
    async (query) =>
      query === renamedInstrument.isin ? [renamedResult, secondExistingResult] : [],
  );
  const ambiguousExistingController = new SyncController(ambiguousExistingHarness.ctx);
  const ambiguousExisting = await connect(ambiguousExistingController);
  assert.equal(ambiguousExisting.imported, 0);
  assert.equal(ambiguousExisting.autoPaused, true);
  assert.match(ambiguousExisting.autoPauseReason ?? '', /conflicting existing assets/);
  assert.equal(ambiguousExistingHarness.saveCalls.length, 0);
}

// Forgetting credentials removes the permanent/candidate secrets and every
// account-bound synchronization marker, including sharded seen-state.
{
  const harness = makeHarness();
  const controller = new SyncController(harness.ctx);
  await connect(controller);
  harness.secrets.set(TRADING212_CANDIDATE_AUTH_SECRET, 'temporary-value');
  harness.storage.set(STORAGE_KEYS.importInProgress, '{"unfinished":true}');
  harness.storage.set(STORAGE_KEYS.reconciliationBlocked, 'true');
  harness.storage.set(`${STORAGE_KEYS.seenShardPrefix}03`, '{"seen":true}');

  await controller.forgetCredentials();

  assert.equal(harness.secrets.has(TRADING212_AUTH_SECRET), false);
  assert.equal(harness.secrets.has(TRADING212_CANDIDATE_AUTH_SECRET), false);
  assert.equal(harness.storage.get(STORAGE_KEYS.configured), 'false');
  assert.equal(harness.storage.get(STORAGE_KEYS.autoEnabled), 'false');
  for (const key of [
    STORAGE_KEYS.accountId,
    STORAGE_KEYS.remoteAccountFingerprint,
    STORAGE_KEYS.baselineAt,
    STORAGE_KEYS.baselineConfirmation,
    STORAGE_KEYS.isaConfirmed,
    STORAGE_KEYS.importInProgress,
    STORAGE_KEYS.reconciliationBlocked,
    STORAGE_KEYS.bindingUpdateInProgress,
    `${STORAGE_KEYS.seenShardPrefix}03`,
  ]) {
    assert.equal(harness.storage.has(key), false, `expected ${key} to be deleted`);
  }
  assert.equal(controller.getState().configured, false);
  assert.equal(controller.getState().autoEnabled, false);
}

console.log('controller native auto-asset tests passed');

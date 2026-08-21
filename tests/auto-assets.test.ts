import assert from 'node:assert/strict';
import type {
  Activity,
  ActivityBulkMutationResult,
  ActivityDetails,
  ActivityImport,
  SymbolSearchResult,
} from '@wealthfolio/addon-sdk';
import {
  assertPersistedSourceActivities,
  createImportLedger,
  nativeAssetResolutionProblems,
  selectUniqueNativeMarketIdentity,
  toSyncActivityCreate,
  validateNativeSaveManyResult,
} from '../src/lib/sync-controller';
import type { MappedActivity } from '../src/types/trading212';

const ACCOUNT_ID = 'wf-account-1';
const NOW = '2026-07-31T12:00:00.000Z';

function securityCandidate(
  remoteKey = 't212:remote-1:fill:new-security',
  overrides: Partial<MappedActivity> = {},
): MappedActivity {
  return {
    stream: 'orders',
    remoteKey,
    remoteDate: NOW,
    signature: `signature:${remoteKey}`,
    instrumentIdentity: '["FFAI_US_EQ","US3073598696","USD"]',
    remoteInstrument: {
      ticker: 'FFAI_US_EQ',
      isin: 'US3073598696',
      currency: 'USD',
      name: 'Faraday Future Intelligent Electric Inc.',
      type: 'STOCK',
    },
    activity: {
      accountId: ACCOUNT_ID,
      activityType: 'BUY',
      date: NOW,
      symbol: 'FFAI',
      currency: 'USD',
      quantity: '2',
      unitPrice: '3.5',
      amount: null,
      fee: '0.01',
      tax: null,
      fxRate: '0.75',
      comment: 'Trading 212 | fill:new-security',
      isValid: true,
      isDraft: false,
      forceImport: false,
      isin: 'US3073598696',
      symbolName: 'Faraday Future Intelligent Electric Inc.',
      exchangeMic: 'XNAS',
      quoteCcy: 'USD',
      instrumentType: 'EQUITY',
      providerId: 'YAHOO',
      providerSymbol: 'FFAI',
    },
    ...overrides,
  };
}

function cashCandidate(
  remoteKey = 't212:remote-1:transaction:deposit-1',
): MappedActivity {
  return {
    stream: 'transactions',
    remoteKey,
    remoteDate: NOW,
    signature: `signature:${remoteKey}`,
    activity: {
      accountId: ACCOUNT_ID,
      activityType: 'DEPOSIT',
      date: NOW,
      symbol: '',
      currency: 'GBP',
      amount: '100',
      fee: null,
      tax: null,
      fxRate: '1',
      comment: 'Trading 212 | transaction:deposit-1',
      isValid: true,
      isDraft: false,
      forceImport: false,
    },
  };
}

function checkedRow(
  candidate: MappedActivity,
  overrides: Partial<ActivityImport> = {},
): ActivityImport {
  return {
    ...candidate.activity,
    lineNumber: 1,
    ...overrides,
  } as ActivityImport;
}

function marketResult(
  overrides: Partial<SymbolSearchResult> = {},
): SymbolSearchResult {
  return {
    exchange: 'NasdaqGS',
    exchangeMic: 'XNAS',
    canonicalSymbol: 'FFAI',
    canonicalExchangeMic: 'XNAS',
    providerId: 'YAHOO',
    providerSymbol: 'FFAI',
    currency: 'USD',
    shortName: 'Faraday Future',
    longName: 'Faraday Future Intelligent Electric Inc.',
    quoteType: 'EQUITY',
    symbol: 'FFAI',
    index: 'quotes',
    score: 1,
    typeDisplay: 'Equity',
    ...overrides,
  };
}

type NativeCreate = ReturnType<typeof toSyncActivityCreate>;

function scalar(value: string | number | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

function createdActivity(
  create: NativeCreate,
  id: string,
  assetId?: string,
): Activity {
  return {
    id,
    accountId: create.accountId,
    ...(assetId ? { assetId } : {}),
    activityType: create.activityType,
    subtype: create.subtype ?? undefined,
    status: 'POSTED',
    activityDate:
      create.activityDate instanceof Date
        ? create.activityDate.toISOString()
        : String(create.activityDate),
    quantity: scalar(create.quantity),
    unitPrice: scalar(create.unitPrice),
    amount: scalar(create.amount),
    fee: scalar(create.fee),
    tax: scalar(create.tax),
    currency: create.currency ?? '',
    fxRate: scalar(create.fxRate),
    notes: create.comment ?? undefined,
    isUserModified: false,
    sourceSystem: create.sourceSystem,
    sourceRecordId: create.sourceRecordId,
    idempotencyKey: create.idempotencyKey,
    needsReview: false,
    createdAt: NOW,
    updatedAt: NOW,
  } as Activity;
}

function persistedActivity(
  create: NativeCreate,
  id: string,
  assetId = '',
): ActivityDetails {
  return {
    id,
    accountId: create.accountId,
    accountName: 'Trading 212 ISA',
    accountCurrency: 'GBP',
    activityType: create.activityType,
    subtype: create.subtype ?? null,
    status: 'POSTED',
    isUserModified: false,
    date: new Date(create.activityDate),
    quantity: scalar(create.quantity),
    unitPrice: scalar(create.unitPrice),
    amount:
      create.amount == null
        ? create.quantity != null && create.unitPrice != null
          ? String(Number(create.quantity) * Number(create.unitPrice))
          : null
        : scalar(create.amount),
    fee: scalar(create.fee),
    tax: scalar(create.tax),
    currency: create.currency ?? '',
    fxRate: scalar(create.fxRate),
    comment: create.comment ?? undefined,
    needsReview: false,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    assetId,
    assetSymbol: assetId ? 'FFAI' : '',
    sourceSystem: create.sourceSystem,
    sourceRecordId: create.sourceRecordId,
    idempotencyKey: create.idempotencyKey,
  } as ActivityDetails;
}

const candidateNew = securityCandidate();

// A unique exact Wealthfolio market result supplies all native metadata needed
// to create a brand-new asset automatically.
{
  const selected = selectUniqueNativeMarketIdentity(candidateNew, [marketResult()]);
  assert.equal(selected.problem, undefined);
  assert.deepEqual(selected.identity, {
    kind: 'new',
    symbol: 'FFAI',
    name: 'Faraday Future Intelligent Electric Inc.',
    exchangeMic: 'XNAS',
    quoteCcy: 'USD',
    instrumentType: 'EQUITY',
    resolutionMethod: 'symbol',
    providerId: 'YAHOO',
    providerSymbol: 'FFAI',
  });
}

// Trading 212's embedded account instruments do not include a security type.
// In that case Wealthfolio must still identify the result as a stock or ETF.
{
  const { type: _type, ...remoteWithoutType } = candidateNew.remoteInstrument!;
  const candidateWithoutType = securityCandidate('t212:remote-1:fill:no-source-type', {
    remoteInstrument: remoteWithoutType,
  });
  const selected = selectUniqueNativeMarketIdentity(candidateWithoutType, [
    marketResult({ quoteType: 'ETF' }),
  ]);
  assert.equal(selected.identity?.resolutionMethod, 'symbol');
  assert.equal(selected.problem, undefined);

  const unsupported = selectUniqueNativeMarketIdentity(candidateWithoutType, [
    marketResult({ quoteType: 'MUTUALFUND' }),
  ]);
  assert.match(unsupported.problem ?? '', /could not uniquely resolve/i);
}

// A canonical symbol change is allowed only for a lookup made with the exact
// validated Trading 212 ISIN, and still requires one unique compatible result.
{
  const oldTicker = securityCandidate('t212:remote-1:fill:old-ticker', {
    remoteInstrument: {
      ticker: 'PSAC_US_EQ',
      isin: 'US3073598696',
      currency: 'USD',
      name: 'Property Solutions Acquisition Corp.',
    },
    activity: {
      ...candidateNew.activity,
      symbol: 'PSAC',
      symbolName: 'Property Solutions Acquisition Corp.',
    },
  });
  const plainTickerLookup = selectUniqueNativeMarketIdentity(oldTicker, [marketResult()]);
  assert.match(plainTickerLookup.problem ?? '', /could not uniquely resolve/i);

  const invalidIsinLookup = selectUniqueNativeMarketIdentity(oldTicker, [marketResult()], {
    lookupKind: 'isin',
    lookupValue: 'US0000000000',
  });
  assert.match(invalidIsinLookup.problem ?? '', /exact validated Trading 212 ISIN/i);

  const isinLookup = selectUniqueNativeMarketIdentity(oldTicker, [marketResult()], {
    lookupKind: 'isin',
    lookupValue: 'US3073598696',
  });
  assert.equal(isinLookup.identity?.symbol, 'FFAI');
  assert.equal(isinLookup.identity?.resolutionMethod, 'isin');

  const ambiguousIsinLookup = selectUniqueNativeMarketIdentity(
    oldTicker,
    [marketResult(), marketResult({ providerId: 'ANOTHER', providerSymbol: 'FFAI:US' })],
    { lookupKind: 'isin', lookupValue: 'US3073598696' },
  );
  assert.match(ambiguousIsinLookup.problem ?? '', /conflicting exact identities/i);
}

// An exact existing asset is reused automatically without requiring provider
// fields or a manually entered UUID. Existing exact matches outrank new ones.
{
  const existing = marketResult({
    existingAssetId: 'asset-ffai-existing',
    providerId: undefined,
    providerSymbol: undefined,
  });
  const selected = selectUniqueNativeMarketIdentity(candidateNew, [marketResult(), existing]);
  assert.equal(selected.identity?.kind, 'existing');
  if (selected.identity?.kind === 'existing') {
    assert.equal(selected.identity.assetId, 'asset-ffai-existing');
  }
}

// Type mismatches and multiple exact provider identities are not guessed.
{
  const wrongType = selectUniqueNativeMarketIdentity(candidateNew, [
    marketResult({ quoteType: 'ETF' }),
  ]);
  assert.match(wrongType.problem ?? '', /could not uniquely resolve/i);

  const ambiguous = selectUniqueNativeMarketIdentity(candidateNew, [
    marketResult(),
    marketResult({ providerId: 'ANOTHER', providerSymbol: 'FFAI:US' }),
  ]);
  assert.match(ambiguous.problem ?? '', /conflicting exact identities/i);
}

const checkedNew = checkedRow(candidateNew);

// checkImport may enrich a row, but it cannot replace the exact native market
// identity already selected by the add-on. This protects a truly empty
// Wealthfolio installation where every security must be created from scratch.
{
  assert.equal(nativeAssetResolutionProblems([candidateNew], [checkedNew]).size, 0);
  for (const [field, value] of [
    ['symbol', 'OTHER'],
    ['exchangeMic', 'XNYS'],
    ['quoteCcy', 'EUR'],
    ['instrumentType', 'BOND'],
    ['providerId', 'OTHER'],
    ['providerSymbol', 'OTHER'],
  ] as const) {
    const changed = checkedRow(candidateNew, { [field]: value });
    const problem = nativeAssetResolutionProblems([candidateNew], [changed]).get(0) ?? '';
    assert.match(problem, new RegExp(field, 'i'));
  }

  const requestedExisting = securityCandidate('t212:remote-1:fill:requested-existing', {
    activity: { ...candidateNew.activity, assetId: 'asset-exact' },
  });
  const changedExisting = checkedRow(requestedExisting, { assetId: 'asset-other' });
  assert.match(
    nativeAssetResolutionProblems([requestedExisting], [changedExisting]).get(0) ?? '',
    /assetId/,
  );
}

const createNew = toSyncActivityCreate(candidateNew, checkedNew, ACCOUNT_ID);

// New securities become full Wealthfolio native asset specifications. The wire
// metadata is deliberately a JSON string because that is what the Rust command
// accepts, even though the SDK type also permits an object.
{
  assert.deepEqual(createNew.asset, {
    symbol: 'FFAI',
    exchangeMic: 'XNAS',
    kind: 'INVESTMENT',
    name: 'Faraday Future Intelligent Electric Inc.',
    quoteMode: 'MARKET',
    quoteCcy: 'USD',
    instrumentType: 'EQUITY',
    providerId: 'YAHOO',
    providerSymbol: 'FFAI',
  });
  assert.equal(typeof createNew.metadata, 'string');
  assert.deepEqual(JSON.parse(createNew.metadata as string), {
    trading212: { schemaVersion: 1, remoteKey: candidateNew.remoteKey },
  });
  assert.equal(createNew.sourceSystem, 'TRADING212');
  assert.equal(createNew.sourceRecordId, candidateNew.remoteKey);
  assert.equal(
    createNew.idempotencyKey,
    `trading212-sync:v1:${ACCOUNT_ID}:${candidateNew.remoteKey}`,
  );

  const defensiveCreate = toSyncActivityCreate(
    candidateNew,
    checkedRow(candidateNew, {
      symbol: 'OTHER',
      exchangeMic: 'XNYS',
      quoteCcy: 'EUR',
      providerId: 'OTHER',
      providerSymbol: 'OTHER',
    }),
    ACCOUNT_ID,
  );
  assert.deepEqual(defensiveCreate.asset, createNew.asset);
}

const candidateExisting = securityCandidate('t212:remote-1:fill:existing-security', {
  instrumentIdentity: '["BABA_US_EQ","US01609W1027","USD"]',
  remoteInstrument: {
    ticker: 'BABA_US_EQ',
    isin: 'US01609W1027',
    currency: 'USD',
    name: 'Alibaba Group Holding Limited',
    type: 'STOCK',
  },
  activity: {
    ...candidateNew.activity,
    symbol: 'BABA',
    isin: 'US01609W1027',
    symbolName: 'Alibaba Group Holding Limited',
    providerSymbol: 'BABA',
  },
});
const createExisting = toSyncActivityCreate(
  candidateExisting,
  checkedRow(candidateExisting, { assetId: 'asset-ffai-existing' }),
  ACCOUNT_ID,
);
assert.deepEqual(createExisting.asset, { id: 'asset-ffai-existing' });

const candidateCash = cashCandidate();
const createCash = toSyncActivityCreate(candidateCash, checkedRow(candidateCash), ACCOUNT_ID);
assert.equal(Object.prototype.hasOwnProperty.call(createCash, 'asset'), false);
assert.equal(typeof createCash.metadata, 'string');
assert.throws(
  () =>
    toSyncActivityCreate(
      candidateCash,
      checkedRow(candidateCash, { assetId: 'asset-should-not-exist' }),
      ACCOUNT_ID,
    ),
  /cash activity unexpectedly resolved to a security asset/i,
);

const candidates = [candidateNew, candidateExisting, candidateCash];
const creates = [createNew, createExisting, createCash];
const createdNew = createdActivity(createNew, 'activity-new', 'asset-ffai-created');
const createdExisting = createdActivity(
  createExisting,
  'activity-existing',
  'asset-ffai-existing',
);
const createdCash = createdActivity(createCash, 'activity-cash');
const successfulSave: ActivityBulkMutationResult = {
  // Deliberately shuffled: temp-ID mappings, not array positions, establish identity.
  created: [createdCash, createdNew, createdExisting],
  updated: [],
  deleted: [],
  errors: [],
  createdMappings: [
    { tempId: createExisting.id, activityId: createdExisting.id },
    { tempId: createCash.id, activityId: createdCash.id },
    { tempId: createNew.id, activityId: createdNew.id },
  ],
};

// saveMany is accepted only when every source row, temporary ID, native
// activity, and asset link is present and unchanged.
{
  const resolved = validateNativeSaveManyResult(
    creates,
    candidates,
    successfulSave,
    ACCOUNT_ID,
  );
  assert.deepEqual([...resolved], [
    [candidateExisting.remoteKey, 'asset-ffai-existing'],
    [candidateNew.remoteKey, 'asset-ffai-created'],
  ]);

  assert.throws(
    () =>
      validateNativeSaveManyResult(
        creates,
        candidates,
        { ...successfulSave, errors: [{ action: 'create', message: 'failed' }] },
        ACCOUNT_ID,
      ),
    /did not atomically create/i,
  );
  assert.throws(
    () =>
      validateNativeSaveManyResult(
        creates,
        candidates,
        {
          ...successfulSave,
          created: [createdCash, { ...createdNew, quantity: '999' }, createdExisting],
        },
        ACCOUNT_ID,
      ),
    /changed native.*quantity/i,
  );
  assert.throws(
    () =>
      validateNativeSaveManyResult(
        creates,
        candidates,
        {
          ...successfulSave,
          created: [{ ...createdCash, assetId: 'unexpected-cash-asset' }, createdNew, createdExisting],
        },
        ACCOUNT_ID,
      ),
    /cash activity to a security asset/i,
  );
}

// The write-ahead ledger records whether each source row expects a new asset,
// an exact existing asset, or no asset. It does not contain a manual mapping.
{
  const ledger = createImportLedger(ACCOUNT_ID, 'remote-1', candidates, creates);
  assert.equal(ledger.schemaVersion, 3);
  assert.equal(ledger.phase, 'prepared');
  assert.equal(ledger.candidateCount, 3);
  assert.deepEqual(
    Object.fromEntries(ledger.candidates.map((entry) => [entry.remoteKey, entry.asset.kind])),
    {
      [candidateNew.remoteKey]: 'new',
      [candidateExisting.remoteKey]: 'existing',
      [candidateCash.remoteKey]: 'cash',
    },
  );
  assert.ok(ledger.batchFingerprint);
  assert.throws(
    () => createImportLedger(ACCOUNT_ID, 'remote-1', candidates, creates.slice(0, 2)),
    /empty or misaligned import ledger/i,
  );
}

// Post-write verification rechecks Trading 212 source identities, all economic
// fields, and asset links before the run is marked committed.
{
  const persisted = [
    persistedActivity(createNew, 'activity-new', 'asset-ffai-created'),
    persistedActivity(createExisting, 'activity-existing', 'asset-ffai-existing'),
    persistedActivity(createCash, 'activity-cash'),
  ];
  assert.doesNotThrow(() =>
    assertPersistedSourceActivities(candidates, creates, persisted, ACCOUNT_ID),
  );
  assert.throws(
    () =>
      assertPersistedSourceActivities(
        candidates,
        creates,
        [persisted[0]!, { ...persisted[0]!, id: 'duplicate-source-row' }, ...persisted.slice(1)],
        ACCOUNT_ID,
      ),
    /persisted 2 activities for one Trading 212 source record/i,
  );
  assert.throws(
    () =>
      assertPersistedSourceActivities(
        candidates,
        creates,
        [{ ...persisted[0]!, quantity: '999' }, ...persisted.slice(1)],
        ACCOUNT_ID,
      ),
    /persisted changed.*quantity/i,
  );
}

console.log('automatic asset tests passed');

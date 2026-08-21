import assert from 'node:assert/strict';
import {
  mapDividend,
  mapOrder,
  mapTransaction,
  mappedActivitySeenSignature,
  mappedActivitySignature,
  symbolCandidates,
  trading212InstrumentIdentity,
} from '../src/lib/mapping';
import type { MappingContext } from '../src/types/trading212';

const babaIdentity = trading212InstrumentIdentity({
  ticker: 'BABA_US_EQ',
  isin: 'US01609W1027',
  currency: 'USD',
})!;

const context: MappingContext = {
  accountId: 'account-1',
  remoteAccountFingerprint: 'remote-212-1',
  accountCurrency: 'GBP',
  // Asset resolution is intentionally not seeded with user-maintained UUIDs.
  // The controller enriches these rows and lets Wealthfolio atomically reuse
  // or create the native asset during saveMany.
  assetsById: new Map(),
  resolvedAssetIdsByInstrument: new Map(),
};

function mustMap<T extends ReturnType<typeof mapOrder>>(result: T) {
  assert.ok(result.mapped, result.pending?.reason ?? 'Expected a mapped activity.');
  return result.mapped;
}

function mustPend<T extends ReturnType<typeof mapOrder>>(result: T) {
  assert.ok(result.pending, 'Expected an event requiring manual review.');
  return result.pending;
}

{
  const result = mustMap(
    mapOrder(
      {
        fill: {
          filledAt: '2026-07-31T12:00:00Z',
          id: 101,
          price: 100,
          quantity: 10,
          type: 'TRADE',
          walletImpact: {
            currency: 'GBP',
            fxRate: 0.75,
            netValue: 753,
            taxes: [
              { name: 'CURRENCY_CONVERSION_FEE', currency: 'GBP', quantity: 0.75 },
              { name: 'STAMP_DUTY_RESERVE_TAX', currency: 'USD', quantity: 3 },
            ],
          },
        },
        order: {
          id: 201,
          side: 'BUY',
          ticker: 'BABA_US_EQ',
          instrument: { ticker: 'BABA_US_EQ', isin: 'US01609W1027', currency: 'USD', name: 'Alibaba' },
        },
      },
      context,
    ),
  );
  assert.equal(result.remoteKey, 't212:remote-212-1:fill:101');
  assert.equal(result.activity.activityType, 'BUY');
  assert.equal(result.activity.assetId, undefined);
  assert.equal(result.activity.symbol, 'BABA');
  assert.equal(result.activity.quantity, '10');
  assert.equal(result.activity.unitPrice, '100');
  assert.equal(result.activity.fee, '1');
  assert.equal(result.activity.tax, '3');
  assert.equal(result.activity.fxRate, '0.75');
}

{
  const result = mustMap(
    mapOrder(
      {
        fill: {
          filledAt: '2026-07-31T12:01:00Z',
          id: 102,
          price: 100,
          quantity: 10,
          type: 'TRADE',
          walletImpact: {
            currency: 'GBP',
            fxRate: 4 / 3,
            netValue: 748.5,
            taxes: [{ name: 'CURRENCY_CONVERSION_FEE', currency: 'GBP', quantity: 1.5 }],
          },
        },
        order: {
          id: 202,
          side: 'SELL',
          ticker: 'BABA_US_EQ',
          instrument: { ticker: 'BABA_US_EQ', isin: 'US01609W1027', currency: 'USD' },
        },
      },
      context,
    ),
  );
  assert.equal(result.activity.activityType, 'SELL');
  assert.equal(result.activity.fee, '2');
  assert.equal(result.activity.fxRate, '0.75');
}

{
  const result = mustMap(
    mapOrder(
      {
        fill: {
          filledAt: '2026-07-31T12:02:00Z',
          id: 103,
          price: 250,
          quantity: 100,
          type: 'TRADE',
          walletImpact: {
            currency: 'GBP',
            fxRate: 1,
            netValue: 250.5,
            taxes: [{ name: 'STAMP_DUTY', currency: 'GBp', quantity: 50 }],
          },
        },
        order: {
          id: 203,
          side: 'BUY',
          ticker: 'VWRL_EQ',
          instrument: { ticker: 'VWRL_EQ', isin: 'IE00B3RBWM25', currency: 'GBp' },
        },
      },
      context,
    ),
  );
  assert.equal(result.activity.currency, 'GBP');
  assert.equal(result.activity.unitPrice, '2.5');
  assert.equal(result.activity.tax, '0.5');
  assert.equal(result.activity.fxRate, '1');
}

{
  const event = mustPend(
    mapOrder(
      {
        fill: {
          filledAt: '2026-07-31T12:03:00Z',
          id: 104,
          price: 10,
          quantity: 1,
          type: 'TRADE',
          walletImpact: {
            currency: 'GBP',
            fxRate: 0.75,
            netValue: 7.5,
            taxes: [{ name: 'UNRECOGNISED_CHARGE', currency: 'GBP', quantity: 0.1 }],
          },
        },
        order: {
          id: 204,
          side: 'BUY',
          ticker: 'BABA_US_EQ',
          instrument: { ticker: 'BABA_US_EQ', isin: 'US01609W1027', currency: 'USD' },
        },
      },
      context,
    ),
  );
  assert.match(event.reason, /Unsupported Trading 212 tax\/fee type/);
}

{
  const event = mustPend(
    mapOrder(
      {
        fill: {
          filledAt: '2026-07-31T12:03:30Z',
          id: 1045,
          price: 10,
          quantity: 1,
          type: 'TRADE',
          walletImpact: {
            currency: 'GBP',
            fxRate: 0.75,
            netValue: 7.5,
            taxes: [{ name: 'CURRENCY_CONVERSION_FEE', currency: 'GBP' }],
          },
        },
        order: {
          id: 2045,
          side: 'BUY',
          ticker: 'BABA_US_EQ',
          instrument: { ticker: 'BABA_US_EQ', isin: 'US01609W1027', currency: 'USD' },
        },
      },
      context,
    ),
  );
  assert.match(event.reason, /amount is missing or invalid/);
}

{
  const event = mustPend(
    mapOrder(
      {
        fill: {
          filledAt: '2026-07-31T12:04:00Z',
          id: 105,
          price: 10,
          quantity: 1,
          type: 'STOCK_SPLIT',
          walletImpact: { currency: 'GBP', fxRate: 0.75, netValue: 7.5 },
        },
        order: {
          id: 205,
          side: 'BUY',
          ticker: 'BABA_US_EQ',
          instrument: { ticker: 'BABA_US_EQ', isin: 'US01609W1027', currency: 'USD' },
        },
      },
      context,
    ),
  );
  assert.match(event.reason, /corporate-action fill type/);
}

{
  const event = mustPend(
    mapOrder(
      {
        fill: {
          filledAt: '2026-07-31T12:05:00Z',
          price: 10,
          quantity: 1,
          type: 'TRADE',
          walletImpact: { currency: 'GBP', fxRate: 0.75, netValue: 7.5 },
        },
        order: {
          id: 206,
          side: 'BUY',
          ticker: 'BABA_US_EQ',
          instrument: { ticker: 'BABA_US_EQ', isin: 'US01609W1027', currency: 'USD' },
        },
      },
      context,
    ),
  );
  assert.match(event.reason, /fill ID is missing/);
}

{
  const event = mustPend(
    mapOrder(
      {
        fill: {
          filledAt: '2026-07-31T12:06:00Z',
          id: 107,
          price: 10,
          quantity: 1,
          type: 'TRADE',
          walletImpact: { currency: 'USD', fxRate: 0.75, netValue: 7.5 },
        },
        order: {
          id: 207,
          side: 'BUY',
          ticker: 'BABA_US_EQ',
          instrument: { ticker: 'BABA_US_EQ', isin: 'US01609W1027', currency: 'USD' },
        },
      },
      context,
    ),
  );
  assert.match(event.reason, /Wallet impact currency/);
}

{
  const result = mustMap(
    mapOrder(
      {
        fill: {
          filledAt: '2026-07-31T12:07:00Z',
          id: 108,
          price: 10,
          quantity: 1,
          type: 'TRADE',
          walletImpact: { currency: 'GBP', fxRate: 0.75, netValue: 7.5 },
        },
        order: {
          id: 208,
          side: 'BUY',
          ticker: 'NEWCO_US_EQ',
          instrument: { ticker: 'NEWCO_US_EQ', isin: 'US0000000001', currency: 'USD' },
        },
      },
      context,
    ),
  );
  assert.equal(result.activity.assetId, undefined);
  assert.equal(result.activity.symbol, 'NEWCO');
  assert.equal(
    result.instrumentIdentity,
    '["NEWCO_US_EQ","US0000000001","USD"]',
  );
}

{
  const result = mustMap(
    mapOrder(
      {
        fill: {
          filledAt: '2026-07-31T12:08:00Z',
          id: 109,
          price: 10,
          quantity: 1,
          type: 'TRADE',
          walletImpact: { currency: 'GBP', fxRate: 0.75, netValue: 7.5 },
        },
        order: {
          id: 209,
          side: 'BUY',
          ticker: 'BABA_US_EQ',
          instrument: {
            ticker: 'BABA_US_EQ',
            isin: 'US01609W1027',
            currency: 'USD',
          },
        },
      },
      context,
    ),
  );
  assert.equal(result.instrumentIdentity, babaIdentity);
  assert.equal(result.activity.assetId, undefined);
  assert.equal(result.activity.symbol, 'BABA');
  const withNativeAsset = { ...result.activity, assetId: 'native-asset-uuid' };
  assert.equal(
    mappedActivitySeenSignature(result.activity),
    mappedActivitySeenSignature(withNativeAsset),
  );
  assert.notEqual(
    mappedActivitySignature(result.activity),
    mappedActivitySignature(withNativeAsset),
  );
}

// Cancelled/unfilled history rows have no economic activity. Missing security
// enrichment on those rows must not pause synchronization.
{
  const event = mustPend(
    mapOrder(
      {
        order: {
          id: 2095,
          side: 'BUY',
          ticker: 'UNFILLED_US_EQ',
          instrument: { ticker: 'UNFILLED_US_EQ', isin: 'US0000000002' },
        },
      },
      context,
    ),
  );
  assert.match(event.reason, /Order or fill fields are incomplete/);
  assert.equal(event.blocksAutomaticImport, undefined);
  assert.equal(event.persistedHistoryFallbackAllowed, undefined);
}

for (const [fillType, side] of [
  ['UNKNOWN', 'BUY'],
  ['TRADE', 'UNKNOWN'],
] as const) {
  const event = mustPend(
    mapOrder(
      {
        fill: {
          filledAt: '2026-07-31T12:08:30Z',
          id: `newco-${fillType}-${side}`,
          price: 10,
          quantity: 1,
          type: fillType,
          walletImpact: { currency: 'GBP', fxRate: 0.75, netValue: 7.5 },
        },
        order: {
          id: `newco-order-${fillType}-${side}`,
          side,
          ticker: 'NEWCO_US_EQ',
          instrument: {
            ticker: 'NEWCO_US_EQ',
            isin: 'US0000000001',
            currency: 'USD',
          },
        },
      },
      context,
    ),
  );
  assert.match(
    event.reason,
    fillType === 'UNKNOWN' ? /corporate-action fill type/ : /neither BUY nor SELL/,
  );
  assert.equal(event.assetMapping, undefined);
}

assert.equal(
  trading212InstrumentIdentity({
    ticker: 'VWRL_EQ',
    isin: 'IE00B3RBWM25',
    currency: 'GBp',
  }),
  '["VWRL_EQ","IE00B3RBWM25","GBX"]',
);
assert.equal(
  trading212InstrumentIdentity({ ticker: 'BABA_US_EQ', currency: 'USD' }),
  undefined,
);
assert.equal(
  trading212InstrumentIdentity({ ticker: 'BABA_US_EQ', isin: 'NOT-AN-ISIN', currency: 'USD' }),
  undefined,
);

{
  const event = mustPend(
    mapOrder(
      {
        fill: {
          filledAt: '2026-07-31T12:09:00Z',
          id: 110,
          price: 10,
          quantity: 1,
          type: 'TRADE',
          walletImpact: { currency: 'GBP', fxRate: 0.75, netValue: 7.5 },
        },
        order: {
          id: 210,
          side: 'BUY',
          currency: 'USD',
          ticker: 'BABA_US_EQ',
          instrument: { ticker: 'BABA_US_EQ', isin: 'US01609W1027' },
        },
      },
      context,
    ),
  );
  assert.match(event.reason, /source quote currency is missing/);
  assert.equal(event.blocksAutomaticImport, true);
}

{
  const event = mustPend(
    mapOrder(
      {
        fill: {
          filledAt: '2026-07-31T12:10:00Z',
          id: 111,
          price: 10,
          quantity: 1,
          type: 'TRADE',
          walletImpact: { currency: 'GBP', fxRate: 0.75, netValue: 7.5 },
        },
        order: {
          id: 211,
          side: 'BUY',
          ticker: 'WRONG_US_EQ',
          instrument: {
            ticker: 'BABA_US_EQ',
            isin: 'US01609W1027',
            currency: 'USD',
          },
        },
      },
      context,
    ),
  );
  assert.match(event.reason, /conflicting embedded and order ticker/);
  assert.equal(event.blocksAutomaticImport, true);
}

{
  const result = mustMap(
    mapDividend(
      {
        amount: 12.34,
        currency: 'GBP',
        paidOn: '2026-07-31T13:00:00Z',
        reference: 'div-1',
        type: 'ORDINARY',
        ticker: 'BABA_US_EQ',
        tickerCurrency: 'USD',
        instrument: { ticker: 'BABA_US_EQ', isin: 'US01609W1027', currency: 'USD', name: 'Alibaba' },
      },
      context,
    ),
  );
  assert.equal(result.activity.activityType, 'DIVIDEND');
  assert.equal(result.activity.amount, '12.34');
  assert.equal(result.activity.currency, 'GBP');
  assert.equal(result.activity.tax, null);
  assert.match(result.activity.comment ?? '', /net cash/);
}

{
  const event = mustPend(
    mapDividend(
      {
        amount: 50,
        currency: 'GBP',
        paidOn: '2026-07-31T13:01:00Z',
        reference: 'div-2',
        type: 'RETURN_OF_CAPITAL',
        ticker: 'BABA_US_EQ',
        tickerCurrency: 'USD',
        instrument: { ticker: 'BABA_US_EQ', isin: 'US01609W1027', currency: 'USD' },
      },
      context,
    ),
  );
  assert.match(event.reason, /manual review/);
}

{
  const event = mustPend(
    mapDividend(
      {
        amount: 50,
        currency: 'GBP',
        paidOn: '2026-07-31T13:01:30Z',
        reference: 'newco-dividend-unknown',
        type: 'UNKNOWN',
        ticker: 'NEWCO_US_EQ',
        tickerCurrency: 'USD',
        instrument: { ticker: 'NEWCO_US_EQ', isin: 'US0000000001', currency: 'USD' },
      },
      context,
    ),
  );
  assert.match(event.reason, /manual review/);
  assert.equal(event.assetMapping, undefined);
}

{
  const result = mustMap(
    mapDividend(
      {
        amount: 1.25,
        currency: 'GBP',
        paidOn: '2026-07-31T13:02:00Z',
        reference: 'interest-distribution-1',
        type: 'INTEREST',
        ticker: 'BABA_US_EQ',
        instrument: { ticker: 'BABA_US_EQ', isin: 'US01609W1027', currency: 'USD' },
      },
      context,
    ),
  );
  assert.equal(result.activity.activityType, 'INTEREST');
}

for (const [type, amount, expectedType, expectedSubtype] of [
  ['DEPOSIT', 100, 'DEPOSIT', undefined],
  ['WITHDRAW', -40, 'WITHDRAWAL', undefined],
  ['INTEREST_ON_FREE_CASH', 1.2, 'INTEREST', undefined],
  ['LENDING_INTEREST', 0.5, 'INTEREST', 'LENDING_INTEREST'],
] as const) {
  const result = mustMap(
    mapTransaction(
      {
        amount,
        currency: 'GBP',
        dateTime: '2026-07-31T14:00:00Z',
        reference: `${type}-${amount}`,
        type,
      },
      context,
    ),
  );
  assert.equal(result.activity.activityType, expectedType);
  assert.equal(result.activity.subtype, expectedSubtype);
  assert.equal(result.activity.amount, String(Math.abs(amount)));
  assert.equal(result.activity.symbol, '');
}

for (const amount of [-2, 2]) {
  const event = mustPend(
    mapTransaction(
      {
        amount,
        currency: 'GBP',
        dateTime: '2026-07-31T14:00:30Z',
        reference: `FEE-${amount}`,
        type: 'FEE',
      },
      context,
    ),
  );
  assert.match(event.reason, /held for review/);
}

{
  const event = mustPend(
    mapTransaction(
      {
        amount: -100,
        currency: 'GBP',
        dateTime: '2026-07-31T14:00:45Z',
        reference: 'deposit-reversal-1',
        type: 'DEPOSIT',
      },
      context,
    ),
  );
  assert.match(event.reason, /deposit reversal/);
}

{
  const event = mustPend(
    mapTransaction(
      {
        amount: 100,
        currency: 'GBP',
        dateTime: '2026-07-31T14:01:00Z',
        reference: 'transfer-1',
        type: 'TRANSFER',
      },
      context,
    ),
  );
  assert.match(event.reason, /manual direction/);
}

assert.deepEqual(symbolCandidates('BABA_US_EQ'), ['BABA_US_EQ', 'BABA']);
assert.deepEqual(symbolCandidates('BRK.B_US_EQ'), ['BRK.B_US_EQ', 'BRK.B', 'BRK-B']);
assert.deepEqual(symbolCandidates('AZNl_EQ'), ['AZNL_EQ', 'AZN']);
assert.deepEqual(symbolCandidates('VWRL_EQ'), ['VWRL_EQ', 'VWRL']);

// The lower-case `l` in Trading 212's London suffix must remain significant
// until suffix decoding. It must not collide with a genuinely upper-case ticker.
assert.equal(
  trading212InstrumentIdentity({
    ticker: 'AZNl_EQ',
    isin: 'GB0009895292',
    currency: 'GBp',
  }),
  '["AZNl_EQ","GB0009895292","GBX"]',
);
assert.notEqual(
  trading212InstrumentIdentity({
    ticker: 'AZNl_EQ',
    isin: 'GB0009895292',
    currency: 'GBp',
  }),
  trading212InstrumentIdentity({
    ticker: 'AZNL_EQ',
    isin: 'GB0009895292',
    currency: 'GBp',
  }),
);

console.log('mapping tests passed');
